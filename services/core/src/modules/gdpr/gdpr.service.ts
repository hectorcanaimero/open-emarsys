import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { PublicApiError } from '@oe/ts-common/http';
import { withSystemScope } from '@oe/ts-common/prisma-tenant';
import { TenantContext } from '@oe/ts-common/tenant';
import type { GdprRequest, GdprRequestKind, GdprRequestStatus, PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { ContactsOutbox } from '../contacts-write/outbox.js';
import { FieldRegistry } from '../fields/field-registry.js';
import { KeyResolver } from '../fields/key-resolver.js';
import { SYSTEM_DB_ROLE, SYSTEM_PRISMA_CLIENT } from '../tenants/system-prisma.module.js';
import { ExportStorage } from './export-storage.js';

/** Presigned export URLs last 24 h (FR-15). */
export const EXPORT_TTL_S = 86_400;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stored instead of the contact once it is forgotten: identifies the subject without personal data. */
export const subjectHash = (contactId: string): string => createHash('sha256').update(contactId).digest('hex');

/**
 * Extension point of the access export: each contributor adds `key` to the JSON with what its
 * store holds about the contact (F2: ClickHouse events). Register with `GdprService.addContributor`.
 */
export interface GdprExportContributor {
  readonly key: string;
  contribute(tenantId: string, contactId: string): Promise<unknown>;
}

export interface GdprRequestDto {
  id: string;
  contact_id: string | null;
  kind: GdprRequestKind;
  status: GdprRequestStatus;
  requested_by: string | null;
  requested_at: string;
  completed_at: string | null;
  result_url: string | null;
  result_expires_at: string | null;
  error: string | null;
}

/**
 * GDPR access and erasure (FR-15, NFR-10). Each request is a `contacts.gdpr_requests` row
 * processed in the background, one at a time, in this process.
 * ponytail: in-process queue instead of BullMQ (A3) because `bullmq` is not a core dependency;
 * rows left `pending`/`running` by a restart are picked up again at bootstrap. Move to BullMQ
 * once core declares it and runs more than one replica.
 */
@Injectable()
export class GdprService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GdprService.name);
  private readonly contributors: GdprExportContributor[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(SYSTEM_PRISMA_CLIENT) private readonly system: PrismaClient,
    private readonly registry: FieldRegistry,
    private readonly keys: KeyResolver,
    private readonly outbox: ContactsOutbox,
    private readonly storage: ExportStorage
  ) {}

  addContributor(contributor: GdprExportContributor): void {
    this.contributors.push(contributor);
  }

  async onApplicationBootstrap(): Promise<void> {
    const tenants = await withSystemScope(() => this.system.tenant.findMany({ select: { id: true } }));
    for (const { id: tenantId } of tenants) {
      const open = await TenantContext.run(tenantId, async () =>
        await this.prisma.gdprRequest.findMany({ where: { status: { in: ['pending', 'running'] } }, orderBy: { id: 'asc' }, select: { id: true } })
      );
      for (const r of open) this.enqueue(tenantId, r.id);
    }
  }

  /** Public v3: the live contact behind the key, else 2008. */
  async requestByKey(tenantId: string, keyId: string, keyValue: string, kind: GdprRequestKind, requestedBy?: string): Promise<GdprRequestDto> {
    const contactId = (await TenantContext.run(tenantId, () => this.keys.resolve(keyId, [keyValue]))).get(keyValue);
    if (!contactId) throw new PublicApiError(2008, `no contact found for key ${keyValue}`, 404);
    return this.request(tenantId, contactId, kind, requestedBy);
  }

  /** Any contact of the tenant, soft-deleted ones included: erasure has to reach them too. */
  async request(tenantId: string, contactId: string, kind: GdprRequestKind, requestedBy?: string): Promise<GdprRequestDto> {
    const req = await TenantContext.run(tenantId, async () => {
      if (!UUID.test(contactId) || (await this.prisma.contact.count({ where: { id: contactId } })) === 0) throw new NotFoundException('contact not found');
      return await this.prisma.gdprRequest.create({ data: { tenantId, contactId, kind, requestedBy } });
    });
    this.enqueue(tenantId, req.id);
    return this.toDto(req);
  }

  /** Newest first, keyset on the (time-ordered) UUID v7 id. */
  async list(tenantId: string, p: { kind?: GdprRequestKind; status?: GdprRequestStatus; cursor?: string; limit: number }) {
    if (p.cursor && !UUID.test(p.cursor)) throw new BadRequestException('invalid cursor');
    const rows = await TenantContext.run(tenantId, async () =>
      await this.prisma.gdprRequest.findMany({
        where: { kind: p.kind, status: p.status, ...(p.cursor ? { id: { lt: p.cursor } } : {}) },
        orderBy: { id: 'desc' },
        take: p.limit + 1,
      })
    );
    const page = rows.slice(0, p.limit);
    return { items: page.map((r) => this.toDto(r)), next_cursor: rows.length > p.limit ? page[page.length - 1]!.id : null };
  }

  /** Resolves once every queued request has been processed. */
  async idle(): Promise<void> {
    let q: Promise<void>;
    do {
      q = this.queue;
      await q;
    } while (q !== this.queue);
  }

  toDto(r: GdprRequest): GdprRequestDto {
    const expires = r.resultKey && r.completedAt ? new Date(r.completedAt.getTime() + EXPORT_TTL_S * 1000) : null;
    return {
      id: r.id,
      contact_id: r.contactId,
      kind: r.kind,
      status: r.status,
      requested_by: r.requestedBy,
      requested_at: r.requestedAt.toISOString(),
      completed_at: r.completedAt?.toISOString() ?? null,
      result_url: r.resultKey && r.completedAt ? this.storage.presignGet(r.resultKey, r.completedAt, EXPORT_TTL_S) : null,
      result_expires_at: expires?.toISOString() ?? null,
      error: r.error,
    };
  }

  private enqueue(tenantId: string, id: string): void {
    this.queue = this.queue.then(() => this.run(tenantId, id));
  }

  private async run(tenantId: string, id: string): Promise<void> {
    try {
      await TenantContext.run(tenantId, async () => {
        const claimed = await this.prisma.gdprRequest.updateMany({ where: { id, status: { in: ['pending', 'running'] } }, data: { status: 'running' } });
        if (claimed.count === 0) return;
        const req = await this.prisma.gdprRequest.findUniqueOrThrow({ where: { id } });
        await (req.kind === 'export' ? this.export(tenantId, req) : this.forget(tenantId, req));
      });
    } catch (err) {
      this.logger.error(`gdpr request ${id} failed: ${err instanceof Error ? err.stack : String(err)}`);
      await TenantContext.run(tenantId, async () =>
        await this.prisma.gdprRequest.update({ where: { id }, data: { status: 'failed', error: err instanceof Error ? err.message : String(err), completedAt: new Date() } })
      ).catch((e: unknown) => this.logger.error(`could not mark gdpr request ${id} failed: ${String(e)}`));
    }
  }

  /** Access: profile with labels, consent history, lists, relational rows and audit, as JSON in `exports`. */
  private async export(tenantId: string, req: GdprRequest): Promise<void> {
    const contactId = req.contactId;
    if (!contactId) throw new Error('contact not found');
    const found = await this.prisma.$transaction(async (tx) => {
      const [contact] = await tx.$queryRaw<{ id: string; data: Record<string, unknown>; version: bigint; created_at: Date; updated_at: Date; deleted_at: Date | null }[]>`
        SELECT id::text, data, version, created_at, updated_at, deleted_at FROM contacts.contacts WHERE id = ${contactId}::uuid`;
      if (!contact) return null;
      return {
        contact,
        consents: await tx.$queryRaw`SELECT channel::text, value, source, text, actor, changed_at FROM contacts.consents
          WHERE contact_id = ${contactId}::uuid ORDER BY changed_at, id`,
        lists: await tx.$queryRaw`SELECT l.id::text, l.name, m.added_at FROM contacts.list_members m JOIN contacts.lists l ON l.id = m.list_id
          WHERE m.contact_id = ${contactId}::uuid ORDER BY l.name`,
        relational: await tx.$queryRaw`SELECT t.id::text AS table_id, t.name AS table_name, r.key, r.data, r.updated_at
          FROM contacts.relational_rows r JOIN contacts.relational_tables t ON t.id = r.table_id
          WHERE r.contact_id = ${contactId}::uuid ORDER BY t.name, r.key`,
        audit: await tx.$queryRaw`SELECT id::text, action, resource_type, actor_type::text, actor_id, diff, at FROM identity.audit_log
          WHERE resource_id = ${contactId} ORDER BY at, id`,
      };
    });
    if (!found) throw new Error('contact not found');
    const { contact, ...rest } = found;
    const defs = await this.registry.fields();
    const doc: Record<string, unknown> = {
      generated_at: new Date().toISOString(),
      profile: {
        id: contact.id,
        version: Number(contact.version),
        created_at: contact.created_at,
        updated_at: contact.updated_at,
        deleted_at: contact.deleted_at,
        fields: Object.entries(contact.data).map(([fieldId, value]) => {
          const def = defs.get(Number(fieldId));
          return { field_id: Number(fieldId), api_name: def?.apiName ?? null, labels: def?.labels ?? null, value };
        }),
      },
      ...rest,
    };
    for (const c of this.contributors) doc[c.key] = await c.contribute(tenantId, contactId);
    const key = `gdpr/${tenantId}/${req.id}.json`;
    await this.storage.put(key, JSON.stringify(doc));
    await this.prisma.gdprRequest.update({ where: { id: req.id }, data: { status: 'done', resultKey: key, completedAt: new Date() } });
  }

  /**
   * Erasure, in one transaction: physically deletes the contact and everything keyed by it,
   * anonymizes its consent history (date and value stay as legal proof), swaps the contact ID
   * of its GDPR requests for a hash and emits `contacts.deleted` with `reason: gdpr` (NFR-10).
   */
  private async forget(tenantId: string, req: GdprRequest): Promise<void> {
    const contactId = req.contactId;
    if (!contactId) {
      await this.prisma.gdprRequest.update({ where: { id: req.id }, data: { status: 'done', completedAt: new Date() } });
      return;
    }
    const hash = subjectHash(contactId);
    const staleExports = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM contacts.unique_values WHERE contact_id = ${contactId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts.list_members WHERE contact_id = ${contactId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts.relational_rows WHERE contact_id = ${contactId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts.identity_links WHERE contact_id = ${contactId}::uuid`;
      if ((await tx.$executeRaw`DELETE FROM contacts.contacts WHERE id = ${contactId}::uuid`) > 0) {
        await this.outbox.deleted(tx, tenantId, [contactId], 'gdpr');
      }
      const requests = await tx.$queryRaw<{ result_key: string | null }[]>`
        WITH old AS (SELECT id, result_key FROM contacts.gdpr_requests WHERE contact_id = ${contactId}::uuid FOR UPDATE)
        UPDATE contacts.gdpr_requests r SET contact_id = NULL, subject_hash = ${hash}, result_key = NULL
        FROM old WHERE r.id = old.id RETURNING old.result_key`;
      await tx.gdprRequest.update({ where: { id: req.id }, data: { status: 'done', completedAt: new Date() } });
      // Last, because the role switch lasts until commit: consents are append-only for `core`;
      // only `core_system` may rewrite `text`, and nothing else (FR-14). It bypasses RLS, hence the tenant filter.
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${SYSTEM_DB_ROLE}`);
      await tx.$executeRaw`UPDATE contacts.consents SET text = NULL
        WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${contactId}::uuid AND text IS NOT NULL`;
      return requests.flatMap((r) => (r.result_key ? [r.result_key] : []));
    });
    this.outbox.flush();
    // Earlier access exports hold the same personal data.
    for (const key of staleExports) {
      await this.storage.remove(key).catch((err: unknown) => this.logger.error(`could not delete export ${key}: ${String(err)}`));
    }
  }
}
