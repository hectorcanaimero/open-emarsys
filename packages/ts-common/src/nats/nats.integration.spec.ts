// Requires Docker. Skipped automatically when it is not available (e.g. some
// local machines); always runs in CI. Spec ref: F0.5.T4 done-when.
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AckPolicy, connect, RetentionPolicy, StorageType } from 'nats';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NatsModule, NatsPublisher, OnEvent } from './index.js';
import { dockerAvailable, startNatsServer, type TestNatsServer } from './testing/nats-server.js';

const TENANT = '01926f00-0000-7000-8000-000000000001';
let deliveries = 0;

@Injectable()
class FailingConsumer {
  @OnEvent('TEST_STREAM', 'test-consumer', 'oe.test.thing_happened.>', { maxDeliver: 2, backoffMs: [50] })
  async onEvent(): Promise<void> {
    deliveries++;
    throw new Error('always fails');
  }
}

@Module({ providers: [FailingConsumer] })
class ConsumerFeatureModule {}

describe.skipIf(!dockerAvailable())('NATS integration (nats-server in docker)', () => {
  let server: TestNatsServer;

  beforeAll(async () => {
    server = await startNatsServer();
    const nc = await connect({ servers: server.servers });
    const jsm = await nc.jetstreamManager();
    await jsm.streams.add({
      name: 'TEST_STREAM',
      subjects: ['oe.test.>', 'oe.system.dead_letter.>'],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
    });
    await nc.close();
  }, 30_000);

  afterAll(() => server?.stop());

  it('publishes an envelope that matches contracts/events/envelope.schema.json', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NatsModule.forRoot({ servers: server.servers, source: 'test-service' })],
    }).compile();
    await moduleRef.init();
    const publisher = moduleRef.get(NatsPublisher);

    const envelope = await publisher.publish('test.thing_happened', TENANT, null, { n: 1 });

    const nc = await connect({ servers: server.servers });
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();
    await jsm.consumers.add('TEST_STREAM', {
      durable_name: 'assert-envelope',
      filter_subject: `oe.test.thing_happened.${TENANT}`,
      ack_policy: AckPolicy.Explicit,
    });
    const consumer = await js.consumers.get('TEST_STREAM', 'assert-envelope');
    const msgs = await consumer.fetch({ max_messages: 1, expires: 3_000 });

    let received: unknown;
    for await (const msg of msgs) {
      received = JSON.parse(Buffer.from(msg.data).toString('utf8'));
      expect(msg.headers?.get('Nats-Msg-Id')).toBe(envelope.id);
      msg.ack();
    }
    await nc.close();
    await moduleRef.close();

    expect(received).toMatchObject({
      id: envelope.id,
      type: 'test.thing_happened',
      schema_version: 1,
      tenant_id: TENANT,
      source: 'test-service',
      contact_id: null,
      data: { n: 1 },
    });
  }, 15_000);

  it('naks a failing consumer with backoff and dead-letters it after maxDeliver', async () => {
    deliveries = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [NatsModule.forRoot({ servers: server.servers, source: 'test-service' }), ConsumerFeatureModule],
    }).compile();
    await moduleRef.init();

    const publisher = moduleRef.get(NatsPublisher);
    await publisher.publish('test.thing_happened', TENANT, null, { n: 2 });

    await vi.waitUntil(() => deliveries >= 2, { timeout: 10_000, interval: 100 });

    const nc = await connect({ servers: server.servers });
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();
    await jsm.consumers.add('TEST_STREAM', {
      durable_name: 'assert-dead-letter',
      filter_subject: `oe.system.dead_letter.${TENANT}`,
      ack_policy: AckPolicy.Explicit,
    });
    const consumer = await js.consumers.get('TEST_STREAM', 'assert-dead-letter');
    const msgs = await consumer.fetch({ max_messages: 1, expires: 5_000 });

    let deadLettered = false;
    for await (const msg of msgs) {
      deadLettered = true;
      msg.ack();
    }
    await nc.close();
    await moduleRef.close();

    expect(deadLettered).toBe(true);
    expect(deliveries).toBe(2);
  }, 20_000);
});
