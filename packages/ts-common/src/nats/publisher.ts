import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { headers as natsHeaders, type NatsConnection } from 'nats';
import { NATS_CONNECTION, NATS_MODULE_OPTIONS, type NatsModuleOptions } from './tokens.js';
import { buildEnvelope, type EventEnvelope, subjectFor } from './envelope.js';

const encoder = new TextEncoder();

/** Publishes C1 envelopes to JetStream, deduplicated by envelope `id`. */
@Injectable()
export class NatsPublisher implements OnModuleDestroy {
  constructor(
    @Inject(NATS_CONNECTION) private readonly nc: NatsConnection,
    @Inject(NATS_MODULE_OPTIONS) private readonly options: NatsModuleOptions
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.nc.drain();
  }

  /** Builds and publishes the C1 envelope for `type`; returns it for logging/tests. */
  async publish<T>(
    type: string,
    tenantId: string,
    contactId: string | null,
    data: T,
    schemaVersion = 1
  ): Promise<EventEnvelope<T>> {
    const envelope = buildEnvelope(this.options.source, type, tenantId, contactId, data, schemaVersion);
    const h = natsHeaders();
    if (envelope.trace_parent) h.set('traceparent', envelope.trace_parent);

    const js = this.nc.jetstream();
    await js.publish(subjectFor(type, tenantId), encoder.encode(JSON.stringify(envelope)), {
      msgID: envelope.id,
      headers: h,
    });
    return envelope;
  }
}
