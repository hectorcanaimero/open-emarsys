import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { buildCursorPage, type CursorPage, parseCursorQuery } from '@oe/ts-common/http';
import { TenantContext } from '@oe/ts-common/tenant';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { ContactsOutbox, type Tx } from '../contacts-write/outbox.js';
import { KeyResolver } from '../fields/key-resolver.js';

export interface ListDto {
  id: string;
  name: string;
  // ponytail: `contacts.lists` has no description column (F1.1 schema); always null until a migration adds it.
  description: null;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface MemberDto {
  contact_id: string;
  added_at: string;
  fields: Record<string, unknown>;
}

/** A key that matched no contact, at its position in the request. */
export interface KeyError {
  index: number;
  key: string;
  code: number;
  text: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Live members only, as `member_count` reports them. */
const COUNT = Prisma.sql`(SELECT count(*) FROM contacts.list_members m JOIN contacts.contacts c ON c.id = m.contact_id AND c.deleted_at IS NULL WHERE m.list_id = l.id)`;

const encode = (parts: string[]): string => Buffer.from(JSON.stringify(parts)).toString('base64url');
function decode(cursor: string, size: number): string[] {
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Array.isArray(parts) && parts.length === size && parts.every((p) => typeof p === 'string')) return parts as string[];
  } catch {
    // fall through
  }
  throw new BadRequestException('invalid cursor');
}

interface ListRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  member_count: bigint;
}

const toDto = (r: ListRow): ListDto => ({
  id: r.id,
  name: r.name,
  description: null,
  member_count: Number(r.member_count),
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});

function pick(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
}

function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('a list with that name already exists');
  throw err;
}

/**
 * Contact lists (FR-13). Membership changes run in one transaction that also writes the
 * `contacts.upserted` of every contact whose `lists` changed to the outbox (F1.2.T3).
 */
@Injectable()
export class ListsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly keys: KeyResolver,
    private readonly outbox: ContactsOutbox
  ) {}

  // ---- lists

  async list(tenantId: string, query: Record<string, unknown>): Promise<CursorPage<ListDto>> {
    const { cursor, limit } = parseCursorQuery(query, { defaultLimit: 50, maxLimit: 200 });
    const q = typeof query.q === 'string' && query.q.length > 0 ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const after = cursor ? decode(cursor, 1)[0]! : null;
    return this.read(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<ListRow[]>`
        SELECT l.id::text, l.name, l.created_at, l.updated_at, ${COUNT} AS member_count FROM contacts.lists l
        WHERE l.tenant_id = ${tenantId}::uuid AND (${q}::text IS NULL OR l.name ILIKE ${q}::text)
          AND (${after}::text IS NULL OR l.id > ${after}::uuid)
        ORDER BY l.id LIMIT ${limit + 1}`;
      return this.page(rows, limit, (r) => encode([r.id]), toDto);
    });
  }

  get(tenantId: string, id: string): Promise<ListDto> {
    return this.read(tenantId, (tx) => this.load(tx, tenantId, id));
  }

  /** Creates a list; a name already used in the tenant is a 409. */
  create(tenantId: string, name: string): Promise<ListDto> {
    return TenantContext.run(tenantId, async () => {
      const row = await this.prisma.contactList.create({ data: { tenantId, name } }).catch(nameTaken);
      return this.get(tenantId, row.id);
    });
  }

  rename(tenantId: string, id: string, name: string | undefined): Promise<ListDto> {
    return TenantContext.run(tenantId, async () => {
      await this.get(tenantId, id);
      if (name !== undefined) await this.prisma.contactList.update({ where: { id }, data: { name } }).catch(nameTaken);
      return this.get(tenantId, id);
    });
  }

  /** Deletes the list and its memberships; the members' `lists` changed, so they get an event. */
  async remove(tenantId: string, id: string): Promise<void> {
    await TenantContext.run(tenantId, () =>
      this.prisma.$transaction(async (tx) => {
        await this.assertList(tx, tenantId, id);
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT contact_id::text AS id FROM contacts.list_members WHERE list_id = ${id}::uuid`;
        await tx.$executeRaw`DELETE FROM contacts.lists WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid`;
        await this.outbox.upserted(tx, tenantId, new Map(rows.map((r) => [r.id, []])));
      })
    );
    this.outbox.flush();
  }

  // ---- membership

  /** Live contacts of the list, newest addition first. */
  members(tenantId: string, id: string, query: Record<string, unknown>): Promise<CursorPage<MemberDto>> {
    const { cursor, limit } = parseCursorQuery(query, { defaultLimit: 50, maxLimit: 200 });
    const [at, cid] = cursor ? decode(cursor, 2) : [null, null];
    return this.read(tenantId, async (tx) => {
      await this.assertList(tx, tenantId, id);
      const rows = await tx.$queryRaw<{ contact_id: string; added_at: Date; data: Record<string, unknown> }[]>`
        SELECT m.contact_id::text, m.added_at, c.data FROM contacts.list_members m
        JOIN contacts.contacts c ON c.id = m.contact_id AND c.deleted_at IS NULL
        WHERE m.list_id = ${id}::uuid AND m.tenant_id = ${tenantId}::uuid
          AND (${at}::text IS NULL OR (m.added_at, m.contact_id) < (${at}::timestamptz, ${cid}::uuid))
        ORDER BY m.added_at DESC, m.contact_id DESC LIMIT ${limit + 1}`;
      return this.page(
        rows,
        limit,
        (r) => encode([r.added_at.toISOString(), r.contact_id]),
        (r) => ({ contact_id: r.contact_id, added_at: r.added_at.toISOString(), fields: pick(r.data, ['1', '2', '3', '4']) })
      );
    });
  }

  /** Lists a live contact belongs to. */
  listsOf(tenantId: string, contactId: string, query: Record<string, unknown>): Promise<CursorPage<ListDto>> {
    const { cursor, limit } = parseCursorQuery(query, { defaultLimit: 50, maxLimit: 200 });
    const after = cursor ? decode(cursor, 1)[0]! : null;
    return this.read(tenantId, async (tx) => {
      if (!UUID.test(contactId)) throw new NotFoundException('contact not found');
      const [exists] = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM contacts.contacts WHERE id = ${contactId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL`;
      if (!exists) throw new NotFoundException('contact not found');
      const rows = await tx.$queryRaw<ListRow[]>`
        SELECT l.id::text, l.name, l.created_at, l.updated_at, ${COUNT} AS member_count FROM contacts.lists l
        JOIN contacts.list_members me ON me.list_id = l.id AND me.contact_id = ${contactId}::uuid
        WHERE l.tenant_id = ${tenantId}::uuid AND (${after}::text IS NULL OR l.id > ${after}::uuid)
        ORDER BY l.id LIMIT ${limit + 1}`;
      return this.page(rows, limit, (r) => encode([r.id]), toDto);
    });
  }

  /** Live contacts in the list. */
  count(tenantId: string, id: string): Promise<number> {
    return this.read(tenantId, async (tx) => (await this.load(tx, tenantId, id)).member_count);
  }

  /** Adds contacts by ID; returns how many memberships are new and the IDs that are no live contact. */
  addContacts(tenantId: string, listId: string, contactIds: string[]) {
    return this.change(tenantId, listId, contactIds, true);
  }

  removeContacts(tenantId: string, listId: string, contactIds: string[]) {
    return this.change(tenantId, listId, contactIds, false);
  }

  /** Same by key: values matching no contact come back as errors and do not abort the rest. */
  addByKeys(tenantId: string, listId: string, keyId: string, values: string[]) {
    return this.byKeys(tenantId, listId, keyId, values, true);
  }

  removeByKeys(tenantId: string, listId: string, keyId: string, values: string[]) {
    return this.byKeys(tenantId, listId, keyId, values, false);
  }

  private byKeys(tenantId: string, listId: string, keyId: string, values: string[], add: boolean) {
    return TenantContext.run(tenantId, async () => {
      await this.get(tenantId, listId);
      const found = await this.keys.resolve(keyId, values);
      const errors: KeyError[] = [];
      values.forEach((key, index) => {
        if (!found.has(key)) errors.push({ index, key, code: 2008, text: 'contact not found' });
      });
      const { changed } = await this.change(tenantId, listId, [...new Set(found.values())], add);
      return { changed, errors };
    });
  }

  private change(tenantId: string, listId: string, contactIds: string[], add: boolean) {
    return TenantContext.run(tenantId, async () => {
      const result = await this.prisma.$transaction(
        async (tx) => {
          await this.assertList(tx, tenantId, listId);
          const ids = contactIds.filter((id) => UUID.test(id));
          const live = new Set(
            (
              await tx.$queryRaw<{ id: string }[]>`
                SELECT id::text FROM contacts.contacts WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND id = ANY(${ids}::uuid[])`
            ).map((r) => r.id)
          );
          const targets = [...live];
          const rows = add
            ? await tx.$queryRaw<{ id: string }[]>`
                INSERT INTO contacts.list_members (list_id, contact_id, tenant_id)
                SELECT ${listId}::uuid, c, ${tenantId}::uuid FROM unnest(${targets}::uuid[]) AS c
                ON CONFLICT DO NOTHING RETURNING contact_id::text AS id`
            : await tx.$queryRaw<{ id: string }[]>`
                DELETE FROM contacts.list_members WHERE list_id = ${listId}::uuid AND contact_id = ANY(${targets}::uuid[]) RETURNING contact_id::text AS id`;
          await this.outbox.upserted(tx, tenantId, new Map(rows.map((r) => [r.id, []])));
          return { changed: rows.length, not_found: contactIds.filter((id) => !live.has(id.toLowerCase())) };
        },
        { timeout: 60_000 }
      );
      this.outbox.flush();
      return result;
    });
  }

  // ---- helpers

  private page<R, T>(rows: R[], limit: number, cursorOf: (r: R) => string, map: (r: R) => T): CursorPage<T> {
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return buildCursorPage(page.map(map), more ? cursorOf(page[page.length - 1]!) : null);
  }

  /** Raw queries only see the tenant's rows inside a transaction (that is where the scope is applied). */
  private read<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return TenantContext.run(tenantId, () => this.prisma.$transaction(fn));
  }

  private async load(tx: Tx, tenantId: string, id: string): Promise<ListDto> {
    if (!UUID.test(id)) throw new NotFoundException('list not found');
    const [row] = await tx.$queryRaw<ListRow[]>`
      SELECT l.id::text, l.name, l.created_at, l.updated_at, ${COUNT} AS member_count FROM contacts.lists l
      WHERE l.id = ${id}::uuid AND l.tenant_id = ${tenantId}::uuid`;
    if (!row) throw new NotFoundException('list not found');
    return toDto(row);
  }

  /** Throws 404 unless the list is in the tenant. */
  async assertList(tx: Tx, tenantId: string, id: string): Promise<void> {
    const [row] = UUID.test(id) ? await tx.$queryRaw<unknown[]>`SELECT 1 FROM contacts.lists WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid` : [];
    if (!row) throw new NotFoundException('list not found');
  }
}
