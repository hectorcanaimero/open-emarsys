import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PublicApiError } from '@oe/ts-common/http';
import { TenantContext } from '@oe/ts-common/tenant';
import { Prisma, type PrismaClient, type RelationalRow, type RelationalTable } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { normalizeValue } from '../fields/field-registry.js';
import { KeyResolver } from '../fields/key-resolver.js';
import type { ColumnInput } from './dto.js';

export const MAX_ROWS = 1000;

export interface BatchError {
  index: number;
  key: string;
  code: number;
  text: string;
}

export const toTableDto = (t: RelationalTable) => ({
  id: t.id,
  name: t.name,
  key_field: t.keyField,
  columns: t.columns as unknown as ColumnInput[],
  created_at: t.createdAt.toISOString(),
  updated_at: t.updatedAt.toISOString(),
});

export const toRowDto = (r: RelationalRow) => ({ key: r.key, data: r.data, updated_at: r.updatedAt.toISOString() });

const nameInUse = (name: string) => new ConflictException(`relational table ${name} already exists`);
const tableNotFound = (id: string) => new PublicApiError(2017, `relational table ${id} does not exist`, 404);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RelationalService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly keys: KeyResolver
  ) {}

  // Prisma promises are lazy: await inside the scope, not after it.
  async list(tenantId: string, limit: number, cursor?: string) {
    const rows = await TenantContext.run(tenantId, async () =>
      await this.prisma.relationalTable.findMany({ where: cursor && UUID.test(cursor) ? { id: { gt: cursor } } : {}, orderBy: { id: 'asc' }, take: limit + 1 })
    );
    return { items: rows.slice(0, limit).map(toTableDto), next_cursor: rows.length > limit ? rows[limit - 1]!.id : null };
  }

  /** 2017 unless the table exists in the tenant; a malformed ID is the same as a missing one. */
  async get(tenantId: string, id: string): Promise<RelationalTable> {
    const table = UUID.test(id) ? await TenantContext.run(tenantId, async () => await this.prisma.relationalTable.findUnique({ where: { id } })) : null;
    if (!table) throw tableNotFound(id);
    return table;
  }

  async create(tenantId: string, input: { name: string; key_field: string; columns: ColumnInput[] }): Promise<RelationalTable> {
    try {
      return await TenantContext.run(tenantId, async () =>
        await this.prisma.relationalTable.create({
          data: { tenantId, name: input.name, keyField: input.key_field, columns: input.columns as unknown as Prisma.InputJsonValue },
        })
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw nameInUse(input.name);
      throw err;
    }
  }

  async update(tenantId: string, id: string, input: { name?: string; add_columns?: ColumnInput[] }): Promise<RelationalTable> {
    const table = await this.get(tenantId, id);
    const columns = table.columns as unknown as ColumnInput[];
    const added = input.add_columns ?? [];
    const taken = new Set(columns.map((c) => c.name));
    if (added.some((c, i) => taken.has(c.name) || added.findIndex((o) => o.name === c.name) !== i)) throw new ConflictException('column already exists');
    try {
      return await TenantContext.run(tenantId, async () =>
        await this.prisma.relationalTable.update({
          where: { id },
          data: { name: input.name, columns: [...columns, ...added] as unknown as Prisma.InputJsonValue },
        })
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw nameInUse(input.name ?? '');
      throw err;
    }
  }

  /** Rows go with the table (FK cascade). */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.get(tenantId, id);
    await TenantContext.run(tenantId, async () => await this.prisma.relationalTable.delete({ where: { id } }));
  }

  /** Rows a contact has in the table, by row key. */
  async rowsOf(tenantId: string, contactId: string, tableId: string, limit: number, cursor?: string) {
    await this.get(tenantId, tableId);
    const rows = UUID.test(contactId)
      ? await TenantContext.run(tenantId, async () =>
          await this.prisma.relationalRow.findMany({
            where: { tableId, contactId, ...(cursor ? { key: { gt: cursor } } : {}) },
            orderBy: { key: 'asc' },
            take: limit + 1,
          })
        )
      : [];
    return { items: rows.slice(0, limit).map(toRowDto), next_cursor: rows.length > limit ? rows[limit - 1]!.key : null };
  }

  /**
   * Upserts rows for the contacts found by `keyId`. Each bad row is reported by index and the
   * valid ones are written in one transaction; an unknown table (2017) or key (2009) fails the call.
   */
  async upsertRows(
    tenantId: string,
    tableId: string,
    keyId: string,
    rows: { key_value: string; row_key: string; data: Record<string, unknown> }[]
  ): Promise<{ upserted: number; errors: BatchError[] }> {
    return TenantContext.run(tenantId, async () => {
      const table = await this.get(tenantId, tableId);
      const columns = new Map((table.columns as unknown as ColumnInput[]).map((c) => [c.name, c]));
      const contacts = await this.keys.resolve(keyId, rows.map((r) => r.key_value));
      const errors: BatchError[] = [];
      const valid = new Map<string, { contactId: string; key: string; data: Record<string, unknown> }>();
      rows.forEach((row, index) => {
        const fail = (code: number, text: string): void => {
          errors.push({ index, key: row.key_value, code, text });
        };
        const contactId = contacts.get(row.key_value);
        if (!contactId) return fail(2008, `contact ${row.key_value} not found`);
        const data: Record<string, unknown> = {};
        for (const [name, raw] of Object.entries(row.data)) {
          const col = columns.get(name);
          if (!col) return fail(2011, `column ${name} does not exist`);
          const res = normalizeValue({ type: col.type, choices: (col.choices ?? []) as never }, raw);
          if (!res.ok) return fail(2010, `column ${name}: ${res.text}`);
          if (res.value !== null) data[name] = res.value;
        }
        const id = `${contactId}\u0000${row.row_key}`;
        if (valid.has(id)) return fail(2014, `row_key ${row.row_key} is duplicated for the contact in this request`);
        valid.set(id, { contactId, key: row.row_key, data });
      });
      if (valid.size > 0) {
        // One statement for the whole batch: a per-row upsert is one round trip each, and with a
        // remote database 100 rows outlast Prisma's 5 s interactive-transaction timeout.
        const batch = [...valid.values()].map((v) => ({ contact_id: v.contactId, key: v.key, data: v.data }));
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO contacts.relational_rows (table_id, contact_id, key, tenant_id, data, updated_at)
            SELECT ${tableId}::uuid, r.contact_id, r.key, ${tenantId}::uuid, r.data, now()
            FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS r(contact_id uuid, key text, data jsonb)
            ON CONFLICT (table_id, contact_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
        });
      }
      return { upserted: valid.size, errors };
    });
  }
}
