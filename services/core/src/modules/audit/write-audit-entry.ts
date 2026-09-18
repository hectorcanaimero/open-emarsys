import type { AuditEntry } from '@oe/ts-common/audit';
import { withSystemScope } from '@oe/ts-common/prisma-tenant';
import { TenantContext } from '@oe/ts-common/tenant';
import { Prisma, type PrismaClient } from '@prisma/client';
import { redactDiff } from './redact.js';

export interface WriteAuditEntryInput extends AuditEntry {
  /** Explicit primary key (the source event's envelope id), for consumer-side idempotency. */
  id?: string;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * Inserts one `identity.audit_log` row, redacting the diff first (FR-6). Scoped to the
 * entry's tenant, or system scope for platform-operator entries (`tenant_id` null).
 *
 * When `id` is given and already exists (a `system.audit.recorded` event redelivered or
 * published twice), the unique violation is swallowed and this resolves to `false` instead
 * of throwing, so callers can treat it as already-recorded rather than a failure.
 */
export async function writeAuditEntry(prisma: PrismaClient, entry: WriteAuditEntryInput): Promise<boolean> {
  const diff = entry.diff === null ? Prisma.DbNull : (redactDiff(entry.diff) as Prisma.InputJsonValue);
  const write = () =>
    prisma.auditLog.create({
      data: {
        id: entry.id,
        tenantId: entry.tenant_id,
        actorType: entry.actor_type,
        actorId: entry.actor_id,
        action: entry.action,
        resourceType: entry.resource_type,
        resourceId: entry.resource_id,
        diff,
        at: new Date(entry.at),
      },
    });

  try {
    if (entry.tenant_id) {
      // The `await` must happen inside the callback: Prisma's `create()` returns a lazy
      // promise that only dispatches the query (and enters the tenant-scope extension) on
      // `.then()`. Awaiting the result of `TenantContext.run()` instead would call `.then()`
      // after the callback (and its AsyncLocalStorage context) has already returned.
      await TenantContext.run(entry.tenant_id, async () => await write());
    } else {
      await withSystemScope(write);
    }
    return true;
  } catch (err) {
    if (isUniqueConstraintViolation(err)) return false;
    throw err;
  }
}
