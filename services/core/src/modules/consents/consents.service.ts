import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { buildEnvelope, NATS_MODULE_OPTIONS, type NatsModuleOptions, subjectFor } from '@oe/ts-common/nats';
import { TenantContext } from '@oe/ts-common/tenant';
import type { ConsentChannel, Prisma, PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { type ContactChange, ContactsWriteService } from '../contacts-write/contacts-write.service.js';
import type { Tx } from '../contacts-write/outbox.js';

/** Consent of a channel lives in this field of the contact (FR-14). */
export const CONSENT_FIELDS: Record<ConsentChannel, string> = { email: '31', sms: '32', push: '33' };
const CHANNEL_OF = Object.fromEntries(Object.entries(CONSENT_FIELDS).map(([c, f]) => [f, c])) as Record<string, ConsentChannel>;

export interface ConsentInput {
  channel: ConsentChannel;
  /** 1 yes, 2 no, null unknown. */
  value: 1 | 2 | null;
  source: string;
  text?: string;
  /** `typ:sub` of the caller. */
  actor?: string;
}

/**
 * Consent history (FR-14). Every change of fields 31/32/33 — made here or through any contact
 * write — appends a `consents` row and a `consent.changed` event inside the write transaction.
 * Explicit changes hand their source/text/actor to the write hook through `ctx`; any other
 * write is recorded with the write's own source (`api`, `import`...) and no text.
 * A write that leaves the value as it was is not a change and records nothing.
 */
@Injectable()
export class ConsentsService implements OnModuleInit {
  private readonly ctx = new AsyncLocalStorage<ConsentInput>();

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(NATS_MODULE_OPTIONS) private readonly nats: NatsModuleOptions,
    private readonly writes: ContactsWriteService
  ) {}

  onModuleInit(): void {
    this.writes.onWrite((tx, tenantId, changes) => this.record(tx, tenantId, changes));
  }

  private async record(tx: Tx, tenantId: string, changes: ContactChange[]): Promise<void> {
    const explicit = this.ctx.getStore();
    const rows: Prisma.ConsentCreateManyInput[] = [];
    for (const c of changes) {
      for (const f of c.changed.filter((f) => f in CHANNEL_OF)) {
        const channel = CHANNEL_OF[f]!;
        const e = explicit?.channel === channel ? explicit : undefined;
        rows.push({
          tenantId,
          contactId: c.contactId,
          channel,
          value: (c.after[f] as number | undefined) ?? null,
          source: e?.source ?? c.source,
          text: e?.text ?? null,
          actor: e?.actor ?? null,
        });
      }
    }
    if (rows.length === 0) return;
    await tx.consent.createMany({ data: rows });
    await tx.contactsOutbox.createMany({
      data: rows.map((r) => {
        const env = buildEnvelope(this.nats.source, 'consent.changed', tenantId, r.contactId, {
          channel: r.channel,
          value: r.value,
          source: r.source,
          text: r.text ?? null,
        });
        return { id: env.id, tenantId, subject: subjectFor('consent.changed', tenantId), envelope: env as unknown as Prisma.InputJsonValue };
      }),
    });
  }

  /** Sets the channel's field through the write engine; the hook records history and events. */
  async set(tenantId: string, contactId: string, input: ConsentInput): Promise<void> {
    const [r] = await this.ctx.run(input, () =>
      this.writes.write(tenantId, 'id', 'update', [{ id: contactId, [CONSENT_FIELDS[input.channel]]: input.value }], input.source)
    );
    if (r!.error) {
      if (r!.error.code === 2008) throw new NotFoundException('contact not found');
      throw new Error(r!.error.text);
    }
  }

  /** History of a contact, newest first; the cursor is `<changed_at>_<id>` of the last item. */
  history(tenantId: string, contactId: string, channel: ConsentChannel | undefined, limit: number, cursor?: string) {
    return TenantContext.run(tenantId, async () => {
      if (!(await this.prisma.contact.findFirst({ where: { id: contactId, deletedAt: null }, select: { id: true } }))) {
        throw new NotFoundException('contact not found');
      }
      const [at, id] = cursor?.split('_') ?? [];
      const rows = await this.prisma.consent.findMany({
        where: {
          contactId,
          channel,
          ...(at && id ? { OR: [{ changedAt: { lt: new Date(at) } }, { changedAt: new Date(at), id: { lt: id } }] } : {}),
        },
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => {
          const [typ = '', ...sub] = (r.actor ?? '').split(':');
          return {
            id: r.id,
            channel: r.channel,
            value: r.value,
            source: r.source,
            text: r.text,
            actor_type: r.actor ? (typ === 'client' ? 'api_client' : typ) : 'service',
            actor_id: r.actor ? sub.join(':') : null,
            changed_at: r.changedAt.toISOString(),
          };
        }),
        next_cursor: rows.length > limit && last ? `${last.changedAt.toISOString()}_${last.id}` : null,
      };
    });
  }
}
