import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PublicApiError } from '@oe/ts-common/http';
import { requireTenant, TenantContext } from '@oe/ts-common/tenant';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { type Choice, FieldRegistry } from '../fields/field-registry.js';
import { KeyResolver } from '../fields/key-resolver.js';

export type FieldValues = Record<string, unknown>;
export interface ContactDto {
  id: string;
  fields: FieldValues;
  version: number;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_FIELDS = [1, 2, 3, 4];
const OPS = ['eq', 'neq', 'contains', 'starts_with', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'] as const;
type Op = (typeof OPS)[number];
const CMP: Partial<Record<Op, string>> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
const CONSENT_FIELDS = { email: '31', sms: '32', push: '33' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `{"1": data->'1', ...}` without missing keys: only the requested field IDs. */
export function pickFields(ids: number[]): Prisma.Sql {
  const pairs = ids.map((f) => Prisma.sql`${String(f)}::text, data -> ${String(f)}::text`);
  return Prisma.sql`jsonb_strip_nulls(jsonb_build_object(${Prisma.join(pairs)}))`;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/** Field IDs of a query parameter (`1,2,3`); 400 unless positive integers. */
export function parseFieldIds(raw: string | undefined, fallback?: number[]): number[] {
  if (!raw) {
    if (fallback) return fallback;
    throw new BadRequestException('fields is required');
  }
  const ids = raw.split(',').map((s) => (/^[1-9]\d*$/.test(s.trim()) ? Number(s) : NaN));
  if (ids.some(Number.isNaN) || ids.length > 500) throw new BadRequestException('fields must be up to 500 comma-separated field IDs');
  return [...new Set(ids)];
}

/** Runs `fn` as `tenantId` (internal C4 routes carry it in the body/query, not in the token). */
export function inTenant<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!tenantId || !UUID.test(tenantId)) throw new BadRequestException('tenant_id must be a UUID');
  return TenantContext.run(tenantId, fn);
}

/** Reads over `contacts.contacts` (FR-9, FR-10, FR-12). Raw SQL on the tenant-scoped Prisma transaction, so RLS applies. */
@Injectable()
export class ContactsQueryService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly registry: FieldRegistry,
    private readonly keys: KeyResolver
  ) {}

  private read<T>(sql: Prisma.Sql): Promise<T[]> {
    return this.prisma.$transaction(async (tx) => tx.$queryRaw<T[]>(sql));
  }

  /** Public getdata: requested fields of the contacts behind `keyValues`; missing keys come back as 2008 errors. */
  async getData(keyId: string, keyValues: string[], fieldIds: number[]) {
    const defs = await this.registry.fields();
    const unknown = fieldIds.find((f) => !defs.has(f));
    if (unknown !== undefined) throw new PublicApiError(2011, `field ${unknown} does not exist`);
    const ids = await this.keys.resolve(keyId, keyValues);
    const rows = ids.size
      ? await this.read<{ id: string; f: FieldValues }>(Prisma.sql`SELECT id::text, ${pickFields(fieldIds)} AS f FROM contacts.contacts
          WHERE tenant_id = ${requireTenant()}::uuid AND deleted_at IS NULL AND id = ANY(${[...new Set(ids.values())]}::uuid[])`)
      : [];
    const byId = new Map(rows.map((r) => [r.id, r.f]));
    const result: Record<string, unknown>[] = [];
    const errors: { index: number; key: string; code: number; text: string }[] = [];
    keyValues.forEach((key, index) => {
      const id = ids.get(key);
      const f = id ? byId.get(id) : undefined;
      if (!id || !f) {
        errors.push({ index, key, code: 2008, text: `no contact found for key ${key}` });
        return;
      }
      result.push({ id, ...Object.fromEntries(fieldIds.map((n) => [String(n), f[String(n)] ?? null])) });
    });
    return { result, errors };
  }

  /** Internal lookup: one query for up to 5,000 contact IDs; unknown or deleted IDs are absent. */
  async lookup(contactIds: string[], fieldIds: number[]): Promise<Record<string, FieldValues>> {
    const rows = await this.read<{ id: string; f: FieldValues }>(Prisma.sql`SELECT id::text, ${pickFields(fieldIds)} AS f FROM contacts.contacts
      WHERE tenant_id = ${requireTenant()}::uuid AND deleted_at IS NULL AND id = ANY(${contactIds}::uuid[])`);
    return Object.fromEntries(rows.map((r) => [r.id, r.f]));
  }

  /** Admin search: `q` matches email, name or external_id prefix; filters are ANDed; keyset pagination on `(updated_at, id)` desc. */
  async search(p: { q?: string; filters: string[]; fields: number[]; cursor?: string; limit: number }) {
    const where: Prisma.Sql[] = [Prisma.sql`tenant_id = ${requireTenant()}::uuid`, Prisma.sql`deleted_at IS NULL`];
    if (p.q) {
      const like = `${escapeLike(p.q)}%`;
      where.push(Prisma.sql`(email_norm LIKE ${like.toLowerCase()} OR data->>'1' ILIKE ${like} OR data->>'2' ILIKE ${like} OR external_id LIKE ${like})`);
    }
    if (p.filters.length) {
      const defs = await this.registry.fields();
      for (const raw of p.filters) where.push(filterSql(raw, defs));
    }
    if (p.cursor) {
      const [ts, id] = decodeCursor(p.cursor);
      where.push(Prisma.sql`(updated_at, id) < (${ts}::timestamptz, ${id}::uuid)`);
    }
    const rows = await this.read<Row>(
      Prisma.sql`SELECT id::text, ${pickFields(p.fields)} AS f, version, created_at, updated_at FROM contacts.contacts
        WHERE ${Prisma.join(where, ' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ${p.limit + 1}`
    );
    const page = rows.slice(0, p.limit);
    const last = page[page.length - 1];
    return { items: page.map(toDto), next_cursor: rows.length > p.limit && last ? encodeCursor(last.updated_at, last.id) : null };
  }

  /** Admin profile: every field, labels in the tenant's locale, current consents (fields 31–33) and lists. */
  async profile(id: string) {
    const tenantId = requireTenant();
    if (!UUID.test(id)) throw new NotFoundException('contact not found');
    const [row] = await this.read<Row>(Prisma.sql`SELECT id::text, data AS f, version, created_at, updated_at FROM contacts.contacts
      WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND deleted_at IS NULL`);
    if (!row) throw new NotFoundException('contact not found');
    const [lists, tenant, defs] = await Promise.all([
      this.read<{ id: string; name: string }>(Prisma.sql`SELECT l.id::text, l.name FROM contacts.list_members m JOIN contacts.lists l ON l.id = m.list_id
        WHERE m.tenant_id = ${tenantId}::uuid AND m.contact_id = ${id}::uuid ORDER BY l.name`),
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultLocale: true } }),
      this.registry.fields(),
    ]);
    const locale = tenant?.defaultLocale ?? 'es';
    const labels = Object.fromEntries([...defs.values()].map((d) => [String(d.fieldId), (d.labels as Record<string, string>)[locale]]));
    const consents = Object.fromEntries(
      Object.entries(CONSENT_FIELDS).map(([channel, key]) => [channel, typeof row.f[key] === 'number' ? row.f[key] : null])
    );
    return { ...toDto(row), labels, consents, lists };
  }
}

interface Row {
  id: string;
  f: FieldValues;
  version: bigint;
  created_at: Date;
  updated_at: Date;
}

const toDto = (r: Row): ContactDto => ({
  id: r.id,
  fields: r.f,
  version: Number(r.version),
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});

const encodeCursor = (ts: Date, id: string): string => Buffer.from(JSON.stringify([ts.toISOString(), id])).toString('base64url');

function decodeCursor(cursor: string): [string, string] {
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
    if (!Number.isFinite(Date.parse(ts)) || !UUID.test(id)) throw new Error('bad cursor');
    return [ts, id];
  } catch {
    throw new BadRequestException('invalid cursor');
  }
}

/** `<fieldId>:<op>:<value>` → SQL condition on the jsonb `data`, typed by the field's definition. */
function filterSql(raw: string, defs: Awaited<ReturnType<FieldRegistry['fields']>>): Prisma.Sql {
  const m = /^([1-9]\d*):([a-z_]+):(.*)$/s.exec(raw);
  const op = m?.[2] as Op | undefined;
  if (!m || !op || !OPS.includes(op)) throw new BadRequestException(`invalid filter: ${raw}`);
  const def = defs.get(Number(m[1]));
  if (!def) throw new BadRequestException(`filter on unknown field ${m[1]}`);
  const key = String(def.fieldId);
  const value = m[3] ?? '';
  const text = Prisma.sql`(data ->> ${key}::text)`;
  const json = Prisma.sql`(data -> ${key}::text)`;
  if (op === 'empty') return Prisma.sql`(${text} IS NULL OR ${text} = '')`;
  if (op === 'not_empty') return Prisma.sql`(${text} IS NOT NULL AND ${text} <> '')`;
  const bad = (): never => {
    throw new BadRequestException(`operator ${op} is not valid for ${def.type} field ${key}`);
  };
  switch (def.type) {
    case 'text':
    case 'date': {
      if (op === 'eq') return Prisma.sql`${text} = ${value}`;
      if (op === 'neq') return Prisma.sql`${text} IS DISTINCT FROM ${value}`;
      if (op === 'contains' && def.type === 'text') return Prisma.sql`${text} ILIKE ${`%${escapeLike(value)}%`}`;
      if (op === 'starts_with') return Prisma.sql`${text} ILIKE ${`${escapeLike(value)}%`}`;
      const cmp = CMP[op];
      return cmp ? Prisma.sql`${text} ${Prisma.raw(cmp)} ${value}` : bad();
    }
    case 'number': {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n)) throw new BadRequestException(`filter value for field ${key} must be a number`);
      const cmp = op === 'eq' ? '=' : op === 'neq' ? '<>' : CMP[op];
      return cmp ? Prisma.sql`(jsonb_typeof(${json}) = 'number' AND ${json} ${Prisma.raw(cmp)} to_jsonb(${n}::numeric))` : bad();
    }
    case 'boolean': {
      if (op !== 'eq' && op !== 'neq') return bad();
      return Prisma.sql`${json} ${Prisma.raw(op === 'eq' ? '=' : '<>')} to_jsonb(${value === 'true' || value === '1'}::boolean)`;
    }
    case 'single_choice':
    case 'multi_choice': {
      if (op !== 'eq' && op !== 'neq') return bad();
      const choice = (def.choices as unknown as Choice[]).find((c) => String(c.id) === value || c.api_name === value);
      if (!choice) throw new BadRequestException(`unknown option ${value} for field ${key}`);
      const has = Prisma.sql`${json} @> to_jsonb(${choice.id}::int)`;
      return op === 'eq' ? has : Prisma.sql`NOT COALESCE(${has}, false)`;
    }
  }
}
