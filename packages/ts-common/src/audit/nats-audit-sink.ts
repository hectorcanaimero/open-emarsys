import { Inject, Injectable } from '@nestjs/common';
import { NatsPublisher } from '../nats/publisher.js';
import { AuditSink, type AuditEntry } from './types.js';

/** Publishes `system.audit.recorded` (stream `SYSTEM`) for every service but core. */
@Injectable()
export class NatsAuditSink extends AuditSink {
  constructor(@Inject(NatsPublisher) private readonly publisher: NatsPublisher) {
    super();
  }

  async record(entry: AuditEntry): Promise<void> {
    if (!entry.tenant_id) {
      throw new Error('NatsAuditSink: platform-operator audit entries (tenant_id null) need a direct AuditSink');
    }
    const { actor_type, actor_id, action, resource_type, resource_id, diff } = entry;
    await this.publisher.publish('system.audit.recorded', entry.tenant_id, null, {
      actor_type,
      actor_id,
      action,
      resource_type,
      resource_id,
      diff,
    });
  }
}
