import { Inject, Injectable } from '@nestjs/common';
import { requireTenant, TenantContext } from '@oe/ts-common/tenant';
import type { FieldDefinition, PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';

export interface Choice {
  id: number;
  api_name: string;
  labels: Record<'es' | 'pt' | 'en', string>;
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; replyCode: 2010 | 2011; text: string };

const bad = (text: string): ValidationResult => ({ ok: false, replyCode: 2010, text });
const good = (value: unknown): ValidationResult => ({ ok: true, value });

/** Normalizes `raw` to what is stored in the contact's jsonb for `def`'s type. `null` removes the key. */
export function normalizeValue(def: Pick<FieldDefinition, 'type' | 'choices'>, raw: unknown): ValidationResult {
  if (raw === null) return good(null);
  const choiceIds = new Set((def.choices as unknown as Choice[]).map((c) => c.id));
  const asId = (v: unknown): number | undefined => {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    return typeof n === 'number' && choiceIds.has(n) ? n : undefined;
  };
  switch (def.type) {
    case 'text':
      return typeof raw === 'string' ? good(raw) : bad('expected a string');
    case 'number': {
      const n = typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
      return typeof n === 'number' && Number.isFinite(n) ? good(n) : bad('expected a decimal number');
    }
    case 'date': {
      const ok = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw)) && new Date(raw).toISOString().startsWith(raw);
      return ok ? good(raw) : bad('expected a date as YYYY-MM-DD');
    }
    case 'boolean': {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') return good(true);
      if (raw === false || raw === 'false' || raw === 0 || raw === '0') return good(false);
      return bad('expected a boolean');
    }
    case 'single_choice': {
      const id = asId(raw);
      return id === undefined ? bad('expected the ID of one of the field options') : good(id);
    }
    case 'multi_choice': {
      const ids = Array.isArray(raw) ? raw.map(asId) : [];
      return Array.isArray(raw) && ids.every((i) => i !== undefined)
        ? good([...new Set(ids as number[])])
        : bad('expected an array of option IDs of the field');
    }
  }
}

/** Field definitions per tenant, cached until `invalidate` (called on every change). */
@Injectable()
export class FieldRegistry {
  private readonly cache = new Map<string, Promise<Map<number, FieldDefinition>>>();

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /** Non-deleted definitions of the current tenant, by field ID. */
  fields(): Promise<Map<number, FieldDefinition>> {
    const tenantId = requireTenant();
    let hit = this.cache.get(tenantId);
    if (!hit) {
      hit = TenantContext.run(tenantId, async () => {
        const rows = await this.prisma.fieldDefinition.findMany({ where: { deletedAt: null }, orderBy: { fieldId: 'asc' } });
        return new Map(rows.map((r) => [r.fieldId, r]));
      });
      hit.catch(() => this.cache.delete(tenantId));
      this.cache.set(tenantId, hit);
    }
    return hit;
  }

  /** Drops the tenant's cached definitions. ponytail: per process; several replicas need an event to invalidate. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  async validateValue(fieldId: number, raw: unknown): Promise<ValidationResult> {
    const def = (await this.fields()).get(fieldId);
    return def ? normalizeValue(def, raw) : { ok: false, replyCode: 2011, text: `field ${fieldId} does not exist` };
  }
}
