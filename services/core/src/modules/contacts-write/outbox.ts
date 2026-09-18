import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { buildEnvelope, NATS_CONNECTION, NATS_MODULE_OPTIONS, type NatsModuleOptions, subjectFor } from '@oe/ts-common/nats';
import { withSystemScope } from '@oe/ts-common/prisma-tenant';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { NatsConnection } from 'nats';
import { SYSTEM_PRISMA_CLIENT } from '../tenants/system-prisma.module.js';

/** Interactive transaction client, as handed to `$transaction(async (tx) => ...)`. */
export type Tx = Prisma.TransactionClient;

const encoder = new TextEncoder();

/**
 * Drains `contacts.outbox` to JetStream: on every `kick` and once a second, so rows left by a
 * crash or a NATS outage go out once it recovers. Rows are locked `FOR UPDATE SKIP LOCKED`,
 * published in id order with `Nats-Msg-Id = id` and deleted in the same transaction; if the
 * process dies after publishing, the rows come back and JetStream drops the duplicates
 * (duplicate_window, deploy/nats/streams).
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  static readonly BATCH = 500;
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;

  constructor(
    @Inject(SYSTEM_PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(NATS_CONNECTION) private readonly nc: NatsConnection
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.kick(), 1_000);
    this.kick();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Starts a drain unless one is running (then it runs again once done). No-op until bootstrap. */
  kick(): void {
    if (!this.timer) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.loop().finally(() => (this.running = undefined));
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.again = false;
        while ((await this.drain()) === OutboxRelay.BATCH);
      } while (this.again && this.timer);
    } catch (err) {
      this.logger.warn(`outbox drain failed, retrying on the next tick: ${String(err)}`);
    }
  }

  /** Publishes and removes up to `BATCH` pending rows; returns how many. */
  drain(): Promise<number> {
    return withSystemScope(() =>
      this.prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<{ id: string; subject: string; envelope: unknown }[]>`
            SELECT id::text, subject, envelope FROM contacts.outbox ORDER BY id LIMIT ${OutboxRelay.BATCH} FOR UPDATE SKIP LOCKED`;
          for (const row of rows) await this.send(row);
          if (rows.length > 0) await tx.$executeRaw`DELETE FROM contacts.outbox WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
          return rows.length;
        },
        { timeout: 60_000 }
      )
    );
  }

  async send(row: { id: string; subject: string; envelope: unknown }): Promise<void> {
    await this.nc.jetstream().publish(row.subject, encoder.encode(JSON.stringify(row.envelope)), { msgID: row.id });
  }
}

/**
 * Writes contacts events into `contacts.outbox` inside the caller's transaction, so they are
 * published if and only if the change commits (NFR-11). Other modules (lists, consents) inject
 * this instead of publishing on their own.
 */
@Injectable()
export class ContactsOutbox {
  constructor(
    @Inject(NATS_MODULE_OPTIONS) private readonly nats: NatsModuleOptions,
    private readonly relay: OutboxRelay
  ) {}

  /**
   * One `contacts.upserted` per contact with its full snapshot as of `tx` (fields, version,
   * lists). `changed` maps each contact to the field IDs this write modified.
   */
  async upserted(tx: Tx, tenantId: string, changed: Map<string, string[]>): Promise<void> {
    if (changed.size === 0) return;
    const rows = await tx.$queryRaw<{ id: string; data: Record<string, unknown>; version: bigint; created_at: Date; updated_at: Date; lists: string[] }[]>`
      SELECT c.id::text, c.data, c.version, c.created_at, c.updated_at,
        coalesce(array_agg(m.list_id::text) FILTER (WHERE m.list_id IS NOT NULL), '{}') AS lists
      FROM contacts.contacts c LEFT JOIN contacts.list_members m ON m.contact_id = c.id
      WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ANY(${[...changed.keys()]}::uuid[])
      GROUP BY c.id`;
    await this.insert(
      tx,
      tenantId,
      'contacts.upserted',
      rows.map((r) => ({
        contactId: r.id,
        data: {
          version: Number(r.version),
          // 40/41 are read-only system fields backed by the row's timestamps.
          fields: { ...r.data, '40': r.created_at.toISOString(), '41': r.updated_at.toISOString() },
          changed: changed.get(r.id)!,
          lists: r.lists,
        },
      }))
    );
  }

  /** One `contacts.deleted` per contact. */
  async deleted(tx: Tx, tenantId: string, contactIds: string[], reason: 'api' | 'gdpr'): Promise<void> {
    await this.insert(tx, tenantId, 'contacts.deleted', contactIds.map((contactId) => ({ contactId, data: { reason } })));
  }

  /** Wakes the relay; call after the transaction commits. */
  flush(): void {
    this.relay.kick();
  }

  private async insert(tx: Tx, tenantId: string, type: string, events: { contactId: string; data: unknown }[]): Promise<void> {
    if (events.length === 0) return;
    await tx.contactsOutbox.createMany({
      data: events.map((e) => {
        const envelope = buildEnvelope(this.nats.source, type, tenantId, e.contactId, e.data);
        return { id: envelope.id, tenantId, subject: subjectFor(type, tenantId), envelope: envelope as unknown as Prisma.InputJsonValue };
      }),
    });
  }
}
