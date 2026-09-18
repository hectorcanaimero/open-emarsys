import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { type EventEnvelope, OnEvent } from '@oe/ts-common/nats';
import { TenantContext } from '@oe/ts-common/tenant';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';

/** An entry of `contracts/dsl/system-fields.json` (F1.1.T1). */
interface SystemField {
  field_id: number;
  api_name: string;
  type: Prisma.FieldDefinitionCreateManyInput['type'];
  unique: boolean;
  read_only: boolean;
  description?: string;
  choices: Prisma.InputJsonValue;
  labels: Prisma.InputJsonValue;
}

// Same depth from src/ and dist/: modules/contacts-shared → services/core → repo root.
const SYSTEM_FIELDS_FILE = path.resolve(__dirname, '../../../../../contracts/dsl/system-fields.json');

export const SYSTEM_FIELDS: readonly SystemField[] = JSON.parse(readFileSync(SYSTEM_FIELDS_FILE, 'utf8'));

/** Loads the system field definitions (IDs 1–99) into every new tenant (FR-7). */
@Injectable()
export class SystemFieldsSeeder {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  @OnEvent('SYSTEM', 'core-contacts-system-fields', 'oe.system.tenant.created.>')
  async onTenantCreated(envelope: EventEnvelope): Promise<void> {
    await this.seed(envelope.tenant_id);
  }

  /** Idempotent: redeliveries skip the definitions already there. */
  async seed(tenantId: string): Promise<void> {
    await TenantContext.run(tenantId, async () => {
      await this.prisma.fieldDefinition.createMany({
        data: SYSTEM_FIELDS.map((f) => ({
          tenantId,
          fieldId: f.field_id,
          apiName: f.api_name,
          labels: f.labels,
          type: f.type,
          choices: f.choices,
          description: f.description ?? null,
          isSystem: true,
          unique: f.unique,
          readOnly: f.read_only,
        })),
        skipDuplicates: true,
      });
    });
  }
}
