import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PublicApiError } from '@oe/ts-common/http';
import { TenantContext } from '@oe/ts-common/tenant';
import { type FieldDefinition, Prisma, type PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import type { FieldCreate, FieldUpdate } from './dto.js';
import { type Choice, FieldRegistry } from './field-registry.js';

export interface FieldDto {
  field_id: number;
  api_name: string;
  type: FieldDefinition['type'];
  labels: unknown;
  choices: Choice[];
  unique: boolean;
  read_only: boolean;
  is_system: boolean;
  deleted_at: string | null;
}

export function toFieldDto(f: FieldDefinition): FieldDto {
  return {
    field_id: f.fieldId,
    api_name: f.apiName,
    type: f.type,
    labels: f.labels,
    choices: f.choices as unknown as Choice[],
    unique: f.unique,
    read_only: f.readOnly,
    is_system: f.isSystem,
    deleted_at: f.deletedAt?.toISOString() ?? null,
  };
}

const nameInUse = (apiName: string) => new PublicApiError(2015, `field name ${apiName} is already in use`, 409);

/** Options keep their ID; entries without one get the next free ID (never reused within the field). */
function withChoiceIds(input: FieldCreate['choices'], current: Choice[]): Choice[] {
  let next = Math.max(0, ...current.map((c) => c.id)) + 1;
  return input.map((c) => ({ id: c.id ?? next++, api_name: c.api_name, labels: c.labels }));
}

@Injectable()
export class FieldsService {
  private readonly logger = new Logger(FieldsService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly registry: FieldRegistry
  ) {}

  // Prisma promises are lazy: await inside the scope, not after it.
  list(tenantId: string, includeDeleted = false): Promise<FieldDefinition[]> {
    return TenantContext.run(tenantId, async () =>
      await this.prisma.fieldDefinition.findMany({ where: includeDeleted ? {} : { deletedAt: null }, orderBy: { fieldId: 'asc' } })
    );
  }

  async create(tenantId: string, input: FieldCreate): Promise<FieldDefinition> {
    try {
      return await TenantContext.run(tenantId, () =>
        this.prisma.$transaction(async (tx) => {
          const [row] = await tx.$queryRaw<{ id: number }[]>`SELECT contacts.next_custom_field_id(${tenantId}::uuid) AS id`;
          return tx.fieldDefinition.create({
            data: {
              tenantId,
              fieldId: row!.id,
              apiName: input.api_name,
              labels: input.labels,
              type: input.type,
              choices: withChoiceIds(input.choices, []) as unknown as Prisma.InputJsonValue,
              unique: input.unique,
            },
          });
        })
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw nameInUse(input.api_name);
      throw err;
    } finally {
      this.registry.invalidate(tenantId);
    }
  }

  async update(tenantId: string, fieldId: number, input: FieldUpdate): Promise<FieldDefinition> {
    try {
      return await TenantContext.run(tenantId, () =>
        this.prisma.$transaction(async (tx) => {
          const def = await tx.fieldDefinition.findFirst({ where: { fieldId, deletedAt: null } });
          if (!def) throw new NotFoundException(`field ${fieldId} not found`);
          const data: Prisma.FieldDefinitionUpdateInput = {};
          if (input.labels) data.labels = input.labels;
          if (input.api_name && input.api_name !== def.apiName) {
            if (def.isSystem) throw new ForbiddenException('system fields only accept labels');
            data.apiName = input.api_name;
          }
          if (input.choices) {
            const current = def.choices as unknown as Choice[];
            const kept = new Set(input.choices.map((c) => c.id));
            if (def.isSystem && (input.choices.length !== current.length || current.some((c) => !kept.has(c.id)) || input.choices.some((c) => c.api_name !== current.find((o) => o.id === c.id)?.api_name))) {
              throw new ForbiddenException('system fields only accept labels');
            }
            if (input.choices.some((c) => c.id !== undefined && !current.some((o) => o.id === c.id))) {
              throw new PublicApiError(2010, 'choice id does not belong to the field');
            }
            for (const gone of current.filter((c) => !kept.has(c.id))) {
              const [used] = await tx.$queryRaw<unknown[]>`SELECT 1 FROM contacts.contacts
                WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND data -> ${String(fieldId)} @> to_jsonb(${gone.id}::int) LIMIT 1`;
              if (used) throw new ConflictException(`choice ${gone.id} is in use by contacts`);
            }
            data.choices = withChoiceIds(input.choices, current) as unknown as Prisma.InputJsonValue;
          }
          return tx.fieldDefinition.update({ where: { tenantId_fieldId: { tenantId, fieldId } }, data });
        })
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw nameInUse(input.api_name ?? '');
      throw err;
    } finally {
      this.registry.invalidate(tenantId);
    }
  }

  /** Marks a custom field deleted and strips its key from contact data in the background. */
  async remove(tenantId: string, fieldId: number): Promise<void> {
    await TenantContext.run(tenantId, async () => {
      const def = await this.prisma.fieldDefinition.findFirst({ where: { fieldId, deletedAt: null } });
      if (!def) throw new NotFoundException(`field ${fieldId} not found`);
      if (def.isSystem) throw new ForbiddenException('system fields cannot be deleted');
      await this.prisma.fieldDefinition.update({ where: { tenantId_fieldId: { tenantId, fieldId } }, data: { deletedAt: new Date() } });
    });
    this.registry.invalidate(tenantId);
    // ponytail: fire-and-forget in this process; a crash before it finishes leaves the key until a sweep is added.
    this.purge(tenantId, fieldId).catch((err: unknown) => this.logger.error(`purge of field ${fieldId} failed: ${String(err)}`));
  }

  /** Removes the deleted field's key (and unique values) from the tenant's contacts. */
  async purge(tenantId: string, fieldId: number): Promise<void> {
    await TenantContext.run(tenantId, () =>
      this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE contacts.contacts SET data = data - ${String(fieldId)}::text
          WHERE tenant_id = ${tenantId}::uuid AND data ? ${String(fieldId)}::text`;
        await tx.uniqueValue.deleteMany({ where: { fieldId } });
      })
    );
  }

  /** Locale the public API uses for labels. */
  async localeOf(tenantId: string): Promise<'es' | 'pt' | 'en'> {
    const t = await TenantContext.run(tenantId, async () => await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultLocale: true } }));
    return t?.defaultLocale ?? 'es';
  }
}
