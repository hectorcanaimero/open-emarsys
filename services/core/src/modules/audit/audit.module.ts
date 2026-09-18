import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AuditConsumer } from './audit-consumer.js';
import { AuditLogController } from './audit-log.controller.js';
import { PostgresAuditSink } from './postgres-audit-sink.js';

export * from './audit-log.controller.js';
export * from './postgres-audit-sink.js';
export * from './write-audit-entry.js';

/**
 * Core's audit module (F0.6.T7, FR-6): `PostgresAuditSink` (plugged into
 * `AuditModule.forRoot({ sink: PostgresAuditSink })` by the F0.6.T8 wiring task), the
 * `core-audit` durable NATS consumer, and `GET /admin/v1/audit-log`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AuditLogController],
  providers: [AuditConsumer, PostgresAuditSink],
  exports: [PostgresAuditSink],
})
export class CoreAuditModule {}
