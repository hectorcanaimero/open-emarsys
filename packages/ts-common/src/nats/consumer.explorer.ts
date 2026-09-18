import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import {
  AckPolicy,
  DeliverPolicy,
  headers as natsHeaders,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  type NatsConnection,
} from 'nats';
import { uuidv7 } from './envelope.js';
import { ON_EVENT_METADATA, type OnEventMetadata } from './on-event.decorator.js';
import { NATS_CONNECTION, NATS_MODULE_OPTIONS, type NatsModuleOptions } from './tokens.js';

const DEFAULT_MAX_DELIVER = 5;
const DEFAULT_ACK_WAIT_MS = 30_000;
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000];

/** Extracts `tenant_id` from a raw envelope payload, without trusting its shape. */
function tenantOf(data: Uint8Array): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as { tenant_id?: unknown }).tenant_id === 'string') {
      return (parsed as { tenant_id: string }).tenant_id;
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

/**
 * Scans every provider for `@OnEvent` methods and turns each into a durable
 * JetStream pull consumer: ack on success, nak with backoff on failure, dead
 * letter to `oe.system.dead_letter.<tenant>` once `maxDeliver` is reached.
 */
@Injectable()
export class NatsConsumerExplorer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NatsConsumerExplorer.name);
  private readonly active: ConsumerMessages[] = [];

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly metadataScanner: MetadataScanner,
    @Inject(NATS_CONNECTION) private readonly nc: NatsConnection,
    @Inject(NATS_MODULE_OPTIONS) private readonly options: NatsModuleOptions
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const jsm = await this.nc.jetstreamManager();
    const js = this.nc.jetstream();

    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance);
      if (!prototype) continue;

      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        const handler = instance[methodName];
        if (typeof handler !== 'function') continue;
        const meta = Reflect.getMetadata(ON_EVENT_METADATA, handler) as OnEventMetadata | undefined;
        if (!meta) continue;
        await this.attach(jsm, js, instance, methodName, meta);
      }
    }
  }

  private async attach(
    jsm: JetStreamManager,
    js: JetStreamClient,
    instance: Record<string, unknown>,
    methodName: string,
    meta: OnEventMetadata
  ): Promise<void> {
    const maxDeliver = meta.maxDeliver ?? this.options.maxDeliver ?? DEFAULT_MAX_DELIVER;
    const ackWaitMs = meta.ackWaitMs ?? this.options.ackWaitMs ?? DEFAULT_ACK_WAIT_MS;
    const backoffMs = meta.backoffMs ?? this.options.backoffMs ?? DEFAULT_BACKOFF_MS;

    try {
      await jsm.consumers.add(meta.stream, {
        durable_name: meta.durable,
        filter_subject: meta.filterSubject,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: maxDeliver,
        ack_wait: ackWaitMs * 1_000_000,
      });
    } catch (err) {
      if (!/already in use|already exists/i.test(String(err))) throw err;
    }

    const consumer = await js.consumers.get(meta.stream, meta.durable);
    const messages = await consumer.consume();
    this.active.push(messages);
    void this.loop(messages, js, instance, methodName, maxDeliver, backoffMs);
  }

  private async loop(
    messages: ConsumerMessages,
    js: JetStreamClient,
    instance: Record<string, unknown>,
    methodName: string,
    maxDeliver: number,
    backoffMs: number[]
  ): Promise<void> {
    for await (const msg of messages) {
      const attempt = msg.info.redeliveryCount + 1;
      try {
        const envelope: unknown = JSON.parse(Buffer.from(msg.data).toString('utf8'));
        const handler = instance[methodName] as (envelope: unknown, msg: JsMsg) => Promise<void> | void;
        await handler.call(instance, envelope, msg);
        msg.ack();
      } catch (err) {
        if (attempt >= maxDeliver) {
          await this.deadLetter(js, msg);
          msg.term();
        } else {
          const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? DEFAULT_BACKOFF_MS[0];
          msg.nak(delay);
        }
        this.logger.warn(`${methodName} attempt ${attempt}/${maxDeliver} failed: ${String(err)}`);
      }
    }
  }

  private async deadLetter(js: JetStreamClient, msg: JsMsg): Promise<void> {
    const tenantId = tenantOf(msg.data);
    // Fresh Nats-Msg-Id: reusing the original would dedup away against the
    // live-stream copy if both land in the same stream.
    const h = natsHeaders();
    const traceParent = msg.headers?.get('traceparent');
    if (traceParent) h.set('traceparent', traceParent);
    await js.publish(`oe.system.dead_letter.${tenantId}`, msg.data, { msgID: uuidv7(), headers: h });
  }

  onModuleDestroy(): void {
    for (const messages of this.active) messages.stop();
  }
}
