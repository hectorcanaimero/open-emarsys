import { Inject, Injectable } from '@nestjs/common';
import { AuditSink, type AuditEntry } from '@oe/ts-common/audit';
import type { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { writeAuditEntry } from './write-audit-entry.js';

/** Core's own `AuditSink` (F0.6.T7): writes `identity.audit_log` directly instead of publishing to NATS. */
@Injectable()
export class PostgresAuditSink extends AuditSink {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {
    super();
  }

  async record(entry: AuditEntry): Promise<void> {
    await writeAuditEntry(this.prisma, entry);
  }
}
