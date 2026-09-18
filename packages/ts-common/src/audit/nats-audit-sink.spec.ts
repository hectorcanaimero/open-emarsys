import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { NatsPublisher } from '../nats/publisher.js';
import { NatsAuditSink } from './nats-audit-sink.js';

describe('NatsAuditSink', () => {
  it('publishes system.audit.recorded with the entry as data', async () => {
    const publish = vi.fn().mockResolvedValue({});
    const sink = new NatsAuditSink({ publish } as unknown as NatsPublisher);

    await sink.record({
      tenant_id: 'tenant-1',
      actor_type: 'user',
      actor_id: 'user-1',
      action: 'contacts.delete',
      resource_type: 'contacts',
      resource_id: 'c-1',
      diff: null,
      at: '2026-09-17T00:00:00.000Z',
    });

    expect(publish).toHaveBeenCalledWith('system.audit.recorded', 'tenant-1', null, {
      actor_type: 'user',
      actor_id: 'user-1',
      action: 'contacts.delete',
      resource_type: 'contacts',
      resource_id: 'c-1',
      diff: null,
    });
  });

  it('rejects a platform-operator entry (tenant_id null)', async () => {
    const sink = new NatsAuditSink({ publish: vi.fn() } as unknown as NatsPublisher);

    await expect(
      sink.record({
        tenant_id: null,
        actor_type: 'user',
        actor_id: 'operator-1',
        action: 'tenants.create',
        resource_type: 'tenants',
        resource_id: 't-1',
        diff: null,
        at: '2026-09-17T00:00:00.000Z',
      })
    ).rejects.toThrow(/tenant_id null/);
  });
});
