import { Inject, Injectable } from '@nestjs/common';
import { PublicApiError } from '@oe/ts-common/http';
import { requireTenant } from '@oe/ts-common/tenant';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { FieldRegistry } from './field-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves `key_id` + values to contact IDs (FR-7): `3` email, `4` external_id, `id`, or a unique custom field. */
@Injectable()
export class KeyResolver {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly registry: FieldRegistry
  ) {}

  /** Throws 2009 unless `keyId` is `id` or an existing, unique field. */
  async assertKey(keyId: string | number): Promise<void> {
    if (keyId === 'id') return;
    const def = /^\d+$/.test(String(keyId)) ? (await this.registry.fields()).get(Number(keyId)) : undefined;
    if (!def?.unique) throw new PublicApiError(2009, `key_id ${keyId} does not exist or is not unique`);
  }

  /** Map from each given value to its live contact's ID; values with no contact are absent. One query. */
  async resolve(keyId: string | number, values: string[]): Promise<Map<string, string>> {
    await this.assertKey(keyId);
    const tenantId = requireTenant();
    const id = String(keyId);
    const norm = (v: string): string => (id === '3' ? v.trim().toLowerCase() : id === '4' ? v.trim() : v);
    const keys = [...new Set(values.map(norm))].filter((k) => id !== 'id' || UUID.test(k));
    const found = new Map<string, string>();
    if (keys.length > 0) {
      const rows = await this.prisma.$transaction(async (tx) => tx.$queryRaw<{ k: string; id: string }[]>(query(tenantId, id, keys)));
      for (const r of rows) found.set(r.k, r.id);
    }
    const out = new Map<string, string>();
    for (const v of values) {
      const hit = found.get(norm(v));
      if (hit) out.set(v, hit);
    }
    return out;
  }
}

function query(tenantId: string, id: string, keys: string[]): Prisma.Sql {
  if (id === 'id') {
    return Prisma.sql`SELECT id::text AS k, id::text AS id FROM contacts.contacts
      WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND id = ANY(${keys}::uuid[])`;
  }
  if (id === '3' || id === '4') {
    const col = Prisma.raw(id === '3' ? 'email_norm' : 'external_id');
    return Prisma.sql`SELECT ${col} AS k, id::text AS id FROM contacts.contacts
      WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND ${col} = ANY(${keys}::text[])`;
  }
  return Prisma.sql`SELECT u.value AS k, u.contact_id::text AS id FROM contacts.unique_values u
    JOIN contacts.contacts c ON c.id = u.contact_id AND c.deleted_at IS NULL
    WHERE u.tenant_id = ${tenantId}::uuid AND u.field_id = ${Number(id)} AND u.value = ANY(${keys}::text[])`;
}
