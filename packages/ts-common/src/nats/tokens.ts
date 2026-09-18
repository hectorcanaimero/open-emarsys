export const NATS_CONNECTION = Symbol('oe:nats:connection');
export const NATS_MODULE_OPTIONS = Symbol('oe:nats:options');

export interface NatsModuleOptions {
  servers: string | string[];
  /** Name of the emitting service, used as `source` on every published envelope. */
  source: string;
  /** Default redelivery attempts before a message is dead-lettered. Default 5. */
  maxDeliver?: number;
  /** Default JetStream ack wait per delivery, in ms. Default 30s. */
  ackWaitMs?: number;
  /** Default nak backoff schedule in ms, indexed by attempt (last value repeats). Default [1s, 5s, 15s]. */
  backoffMs?: number[];
}
