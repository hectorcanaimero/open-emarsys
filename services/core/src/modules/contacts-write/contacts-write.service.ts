import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '@oe/ts-common/nats';
import { TenantContext } from '@oe/ts-common/tenant';
import { type FieldDefinition, Prisma, type PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { FieldRegistry, normalizeValue } from '../fields/field-registry.js';
import { KeyResolver } from '../fields/key-resolver.js';
import { ContactsOutbox, type Tx } from './outbox.js';

/** `create` only inserts (existing key → 2012), `update` only changes (missing key → 2008), `upsert` both. */
export type WriteMode = 'create' | 'update' | 'upsert';

export interface ItemError {
  code: number;
  text: string;
  field_id?: string;
}

export interface ItemResult {
  index: number;
  /** The item's key value, when present. */
  key: string | null;
  /** `null` when the item failed. */
  id: string | null;
  created: boolean;
  /** Field IDs this write modified (empty for a no-op). */
  changed: string[];
  error?: ItemError;
}

/** A contact written by a batch, as handed to hooks. */
export interface ContactChange {
  contactId: string;
  created: boolean;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: string[];
  /** Who wrote it: `api` by default, `import` etc. from the internal API. */
  source: string;
}

/** Runs inside the batch transaction after the contacts are written (e.g. consent history, F1.2.T6). */
export type ContactWriteHook = (tx: Tx, tenantId: string, changes: ContactChange[]) => Promise<void>;

type Data = Record<string, unknown>;
interface Pending {
  r: ItemResult;
  set: Data;
}

/** The batch lost a race on a unique value or a row; rerun it from key resolution. */
class Retry extends Error {}

const ATTEMPTS = 3;

/** Same normalization as the unique indexes / `KeyResolver`: email lowercased, external_id trimmed. */
const normFor = (fieldId: string) => (v: string) => (fieldId === '3' ? v.trim().toLowerCase() : fieldId === '4' ? v.trim() : v);

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2002' || (err.meta as { code?: string } | undefined)?.code === '23505')
  );
}

const json = (v: unknown) => JSON.stringify(v);

/**
 * Batch write engine behind the public, admin and internal contact APIs (FR-8): per-item
 * validation with `FieldRegistry`, keys resolved with `KeyResolver`, then one transaction for
 * all valid items with their `contacts.upserted` events in the outbox.
 */
@Injectable()
export class ContactsWriteService {
  private readonly hooks: ContactWriteHook[] = [];

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly registry: FieldRegistry,
    private readonly keys: KeyResolver,
    private readonly outbox: ContactsOutbox
  ) {}

  /** Registers a hook run in every write transaction. */
  onWrite(hook: ContactWriteHook): void {
    this.hooks.push(hook);
  }

  /**
   * Writes `items` (maps of field ID → value, each carrying its `keyId` field) and returns one
   * result per item, in order. Invalid items fail alone; `null` removes a field.
   */
  write(tenantId: string, keyId: string, mode: WriteMode, items: Data[], source = 'api'): Promise<ItemResult[]> {
    return TenantContext.run(tenantId, async () => {
      await this.keys.assertKey(keyId);
      for (let attempt = 1; ; attempt++) {
        try {
          const results = await this.attempt(tenantId, keyId, mode, items, source);
          this.outbox.flush();
          return results;
        } catch (err) {
          if (attempt >= ATTEMPTS || !(err instanceof Retry || isUniqueViolation(err))) throw err;
        }
      }
    });
  }

  /** A live contact by ID (call with an ID the engine returned). */
  get(tenantId: string, id: string) {
    return TenantContext.run(tenantId, async () => await this.prisma.contact.findFirstOrThrow({ where: { id, deletedAt: null } }));
  }

  /** Soft-deletes the contacts matching `items`' keys; unknown keys fail with 2008. */
  delete(tenantId: string, keyId: string, items: Data[]): Promise<ItemResult[]> {
    return TenantContext.run(tenantId, async () => {
      await this.keys.assertKey(keyId);
      const { results, pending } = this.keyed(keyId, items);
      const found = await this.keys.resolve(keyId, pending.map((p) => p.r.key!));
      for (const p of pending) {
        const id = found.get(p.r.key!);
        if (id) p.r.id = id;
        else fail(p.r, 2008, 'contact not found');
      }
      const deleted = new Set(await this.softDelete(tenantId, pending.flatMap((p) => (p.r.id ? [p.r.id] : []))));
      for (const p of pending) if (p.r.id && !deleted.has(p.r.id)) fail(p.r, 2008, 'contact not found');
      return results;
    });
  }

  /** Sets `deleted_at` (and frees unique values) on live contacts; returns the IDs deleted. */
  async softDelete(tenantId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const deleted = await TenantContext.run(tenantId, () =>
      this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          UPDATE contacts.contacts SET deleted_at = now(), updated_at = now(), version = version + 1
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND id = ANY(${ids}::uuid[]) RETURNING id::text`;
        const gone = rows.map((r) => r.id);
        if (gone.length > 0) {
          await tx.$executeRaw`DELETE FROM contacts.unique_values WHERE tenant_id = ${tenantId}::uuid AND contact_id = ANY(${gone}::uuid[])`;
          await this.outbox.deleted(tx, tenantId, gone, 'api');
        }
        return gone;
      })
    );
    this.outbox.flush();
    return deleted;
  }

  /** Results for every item plus the ones with a usable, non-repeated key. */
  private keyed(keyId: string, items: Data[]): { results: ItemResult[]; pending: Pending[] } {
    const norm = normFor(keyId);
    const seen = new Set<string>();
    const results: ItemResult[] = [];
    const pending: Pending[] = [];
    items.forEach((item, index) => {
      const raw = item[keyId];
      const key = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
      const r: ItemResult = { index, key: key || null, id: null, created: false, changed: [] };
      results.push(r);
      if (!key.trim()) return fail(r, 2014, `key field ${keyId} is missing`);
      if (seen.has(norm(key))) return fail(r, 2014, `key ${key} is repeated in the request`);
      seen.add(norm(key));
      pending.push({ r, set: {} });
    });
    return { results, pending };
  }

  private async attempt(tenantId: string, keyId: string, mode: WriteMode, items: Data[], source: string): Promise<ItemResult[]> {
    const defs = await this.registry.fields();
    const { results, pending } = this.keyed(keyId, items);

    for (const p of pending) {
      for (const [k, raw] of Object.entries(items[p.r.index]!)) {
        if (k === 'id' && keyId === 'id') continue;
        const def = /^[1-9]\d*$/.test(k) ? defs.get(Number(k)) : undefined;
        if (!def || def.readOnly) {
          fail(p.r, def ? 2013 : 2011, def ? `field ${k} is read-only` : `field ${k} does not exist`, k);
          break;
        }
        const v = normalizeValue(def, raw);
        if (!v.ok) {
          fail(p.r, v.replyCode, `field ${k}: ${v.text}`, k);
          break;
        }
        p.set[k] = v.value;
      }
    }

    let valid = pending.filter((p) => !p.r.error);
    const found = await this.keys.resolve(keyId, valid.map((p) => p.r.key!));
    for (const p of valid) {
      const id = found.get(p.r.key!);
      if (id && mode === 'create') fail(p.r, 2012, 'contact already exists');
      else if (!id && (mode === 'update' || keyId === 'id')) fail(p.r, 2008, 'contact not found');
      else {
        p.r.id = id ?? uuidv7();
        p.r.created = !id;
      }
    }
    valid = valid.filter((p) => !p.r.error);
    await this.checkUnique(keyId, defs, valid);
    valid = valid.filter((p) => !p.r.error);
    if (valid.length === 0) return results;

    await this.prisma.$transaction(
      async (tx) => {
        const changes = [...(await this.update(tx, tenantId, valid.filter((p) => !p.r.created), source)), ...(await this.insert(tx, tenantId, valid.filter((p) => p.r.created), source))];
        await this.syncUniqueValues(tx, tenantId, defs, changes);
        for (const hook of this.hooks) await hook(tx, tenantId, changes);
        await this.outbox.upserted(tx, tenantId, new Map(changes.map((c) => [c.contactId, c.changed])));
      },
      { timeout: 60_000 }
    );
    return results;
  }

  /** Fails items that set a unique field to a value another contact (or an earlier item) holds. */
  private async checkUnique(keyId: string, defs: Map<number, FieldDefinition>, items: Pending[]): Promise<void> {
    for (const def of defs.values()) {
      const fk = String(def.fieldId);
      if (!def.unique || fk === keyId) continue;
      const setters = items.filter((p) => !p.r.error && p.set[fk] != null && String(p.set[fk]).trim() !== '');
      if (setters.length === 0) continue;
      const owners = await this.keys.resolve(fk, setters.map((p) => String(p.set[fk])));
      const norm = normFor(fk);
      const seen = new Set<string>();
      for (const p of setters) {
        const value = String(p.set[fk]);
        const owner = owners.get(value);
        if (seen.has(norm(value))) fail(p.r, 2014, `value of field ${fk} is repeated in the request`, fk);
        else if (owner && owner !== p.r.id) fail(p.r, 2012, `value of field ${fk} belongs to another contact`, fk);
        seen.add(norm(value));
      }
    }
  }

  /** Merges the sent keys into existing contacts; unchanged contacts are left alone (no version bump). */
  private async update(tx: Tx, tenantId: string, items: Pending[], source: string): Promise<ContactChange[]> {
    if (items.length === 0) return [];
    const rows = await tx.$queryRaw<{ id: string; data: Data }[]>`
      SELECT id::text, data FROM contacts.contacts
      WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND id = ANY(${items.map((p) => p.r.id)}::uuid[]) FOR UPDATE`;
    if (rows.length !== items.length) throw new Retry('a contact was deleted concurrently');
    const before = new Map(rows.map((r) => [r.id, r.data]));

    const changes: ContactChange[] = [];
    for (const p of items) {
      const old = before.get(p.r.id!)!;
      const next = { ...old };
      for (const [k, v] of Object.entries(p.set)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      p.r.changed = Object.keys(p.set).filter((k) => !isDeepStrictEqual(old[k], next[k]));
      if (p.r.changed.length > 0) changes.push({ contactId: p.r.id!, created: false, before: old, after: next, changed: p.r.changed, source });
    }
    if (changes.length > 0) {
      await tx.$executeRaw`
        UPDATE contacts.contacts c SET data = x.data, version = c.version + 1, updated_at = now()
        FROM jsonb_to_recordset(${json(changes.map((c) => ({ id: c.contactId, data: c.after })))}::jsonb) AS x(id uuid, data jsonb)
        WHERE c.id = x.id AND c.tenant_id = ${tenantId}::uuid`;
    }
    return changes;
  }

  /** Inserts new contacts; `ON CONFLICT DO NOTHING` on the partial uniques turns a lost race into a retry. */
  private async insert(tx: Tx, tenantId: string, items: Pending[], source: string): Promise<ContactChange[]> {
    if (items.length === 0) return [];
    const changes = items.map((p) => {
      const after = Object.fromEntries(Object.entries(p.set).filter(([, v]) => v !== null));
      p.r.changed = Object.keys(after);
      return { contactId: p.r.id!, created: true, before: {}, after, changed: p.r.changed, source };
    });
    const inserted = await tx.$queryRaw<unknown[]>`
      INSERT INTO contacts.contacts (id, tenant_id, data)
      SELECT x.id, ${tenantId}::uuid, x.data FROM jsonb_to_recordset(${json(changes.map((c) => ({ id: c.contactId, data: c.after })))}::jsonb) AS x(id uuid, data jsonb)
      ON CONFLICT DO NOTHING RETURNING id`;
    if (inserted.length !== items.length) throw new Retry('a key was taken concurrently');
    return changes;
  }

  /** Keeps `unique_values` in step with custom unique fields (3 and 4 are indexed columns). */
  private async syncUniqueValues(tx: Tx, tenantId: string, defs: Map<number, FieldDefinition>, changes: ContactChange[]): Promise<void> {
    const cleared: { contact_id: string; field_id: number }[] = [];
    const values: { contact_id: string; field_id: number; value: string }[] = [];
    for (const c of changes) {
      for (const k of c.changed) {
        if (k === '3' || k === '4' || !defs.get(Number(k))?.unique) continue;
        cleared.push({ contact_id: c.contactId, field_id: Number(k) });
        const v = c.after[k];
        if (v != null && String(v).trim() !== '') values.push({ contact_id: c.contactId, field_id: Number(k), value: String(v) });
      }
    }
    if (cleared.length > 0) {
      await tx.$executeRaw`
        DELETE FROM contacts.unique_values u USING jsonb_to_recordset(${json(cleared)}::jsonb) AS x(contact_id uuid, field_id int)
        WHERE u.tenant_id = ${tenantId}::uuid AND u.contact_id = x.contact_id AND u.field_id = x.field_id`;
    }
    if (values.length > 0) {
      const inserted = await tx.$queryRaw<unknown[]>`
        INSERT INTO contacts.unique_values (tenant_id, field_id, value, contact_id)
        SELECT ${tenantId}::uuid, x.field_id, x.value, x.contact_id FROM jsonb_to_recordset(${json(values)}::jsonb) AS x(contact_id uuid, field_id int, value text)
        ON CONFLICT DO NOTHING RETURNING 1`;
      if (inserted.length !== values.length) throw new Retry('a unique value was taken concurrently');
    }
  }
}

function fail(r: ItemResult, code: number, text: string, fieldId?: string): void {
  r.error = fieldId ? { code, text, field_id: fieldId } : { code, text };
  r.id = null;
  r.created = false;
  r.changed = [];
}
