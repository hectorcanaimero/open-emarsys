import { Inject, Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@oe/ts-common/nats';
import { OnEvent } from '@oe/ts-common/nats';
import type { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { writeAuditEntry } from './write-audit-entry.js';

interface SystemAuditRecordedData {
  actor_type: 'user' | 'client' | 'service';
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  diff: unknown;
}

/**
 * Durable consumer `core-audit` (FR-6): persists `system.audit.recorded` events published by
 * every service but core into `identity.audit_log`, idempotently by envelope `id`.
 */
@Injectable()
export class AuditConsumer {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  @OnEvent('SYSTEM', 'core-audit', 'oe.system.audit.recorded.>')
  async onAuditRecorded(envelope: EventEnvelope<SystemAuditRecordedData>): Promise<void> {
    await writeAuditEntry(this.prisma, {
      id: envelope.id,
      tenant_id: envelope.tenant_id,
      actor_type: envelope.data.actor_type,
      actor_id: envelope.data.actor_id,
      action: envelope.data.action,
      resource_type: envelope.data.resource_type,
      resource_id: envelope.data.resource_id,
      diff: envelope.data.diff,
      at: envelope.occurred_at,
    });
  }
}
