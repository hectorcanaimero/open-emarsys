// C1 envelope (contracts/events/envelope.schema.json): published on subject
// `oe.<type>.<tenant_id>` with header `Nats-Msg-Id = id` for JetStream dedup.
import { randomBytes } from 'node:crypto';
import { context as otelContext, trace } from '@opentelemetry/api';

export interface EventEnvelope<T = unknown> {
  /** UUID v7, lowercase. Also the JetStream dedup key (`Nats-Msg-Id`). */
  id: string;
  /** Dotted event type, e.g. `contacts.upserted`. First segment picks the stream. */
  type: string;
  schema_version: number;
  tenant_id: string;
  /** RFC 3339 with exactly millisecond precision. */
  occurred_at: string;
  /** Name of the emitting service, e.g. `core`. */
  source: string;
  contact_id: string | null;
  /** W3C traceparent (version 00), when a span is active. */
  trace_parent?: string;
  data: T;
}

/** UUID v7 (RFC 9562): 48-bit ms timestamp, version 7, random tail. */
export function uuidv7(): string {
  const ms = BigInt(Date.now());
  const rnd = randomBytes(10);
  const b = Buffer.alloc(16);
  b[0] = Number((ms >> 40n) & 0xffn);
  b[1] = Number((ms >> 32n) & 0xffn);
  b[2] = Number((ms >> 24n) & 0xffn);
  b[3] = Number((ms >> 16n) & 0xffn);
  b[4] = Number((ms >> 8n) & 0xffn);
  b[5] = Number(ms & 0xffn);
  b[6] = 0x70 | (rnd[0]! & 0x0f);
  b[7] = rnd[1]!;
  b[8] = 0x80 | (rnd[2]! & 0x3f);
  rnd.copy(b, 9, 3, 10);
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Current span's W3C `traceparent`, or `undefined` outside a span. */
export function currentTraceParent(): string | undefined {
  const span = trace.getSpanContext(otelContext.active());
  if (!span) return undefined;
  const flags = span.traceFlags.toString(16).padStart(2, '0');
  return `00-${span.traceId}-${span.spanId}-${flags}`;
}

/** Builds a C1 envelope, filling `id`, `occurred_at` and `trace_parent`. */
export function buildEnvelope<T>(
  source: string,
  type: string,
  tenantId: string,
  contactId: string | null,
  data: T,
  schemaVersion = 1
): EventEnvelope<T> {
  const envelope: EventEnvelope<T> = {
    id: uuidv7(),
    type,
    schema_version: schemaVersion,
    tenant_id: tenantId,
    occurred_at: new Date().toISOString(),
    source,
    contact_id: contactId,
    data,
  };
  const traceParent = currentTraceParent();
  if (traceParent) envelope.trace_parent = traceParent;
  return envelope;
}

/** Subject for an envelope of `type` under `tenantId` (C1). */
export function subjectFor(type: string, tenantId: string): string {
  return `oe.${type}.${tenantId}`;
}
