import { SetMetadata } from '@nestjs/common';

export const ON_EVENT_METADATA = 'oe:nats:on-event';

export interface OnEventOptions {
  /** Redelivery attempts before dead-lettering. Overrides the module default. */
  maxDeliver?: number;
  /** JetStream ack wait per delivery, in ms. Overrides the module default. */
  ackWaitMs?: number;
  /** Nak backoff schedule in ms, indexed by attempt. Overrides the module default. */
  backoffMs?: number[];
}

export interface OnEventMetadata extends OnEventOptions {
  stream: string;
  durable: string;
  filterSubject: string;
}

/**
 * Marks a provider method as the handler for a durable JetStream pull
 * consumer. The method receives `(envelope: EventEnvelope, msg: JsMsg)`;
 * returning normally acks the message, throwing naks it with backoff and,
 * after `maxDeliver` attempts, dead-letters it to `oe.system.dead_letter.<tenant>`.
 */
export function OnEvent(
  stream: string,
  durable: string,
  filterSubject: string,
  options?: OnEventOptions
): MethodDecorator {
  const metadata: OnEventMetadata = { stream, durable, filterSubject, ...options };
  return SetMetadata(ON_EVENT_METADATA, metadata);
}
