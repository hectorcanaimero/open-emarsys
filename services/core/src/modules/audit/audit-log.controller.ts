import { BadRequestException, Controller, ForbiddenException, Get, Inject, Query } from '@nestjs/common';
import { CurrentPrincipal, RequirePermission, type Principal } from '@oe/ts-common/auth';
import { buildCursorPage, parseCursorQuery, type CursorPage } from '@oe/ts-common/http';
import { TenantContext } from '@oe/ts-common/tenant';
import type { AuditLog } from '@prisma/client';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';

export interface AuditEntryDto {
  id: string;
  occurred_at: string;
  tenant_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip: string | null;
  changes: unknown;
}

interface RowCursor {
  at: string;
  id: string;
}

function encodeCursor(row: RowCursor): string {
  return Buffer.from(JSON.stringify(row), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): RowCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as RowCursor).at === 'string' && typeof (parsed as RowCursor).id === 'string') {
      return parsed as RowCursor;
    }
  } catch {
    // falls through to the exception below
  }
  throw new BadRequestException('invalid cursor');
}

function parseDate(raw: unknown, field: string): Date | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new BadRequestException(`${field} must be a date-time string`);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} must be a valid date-time`);
  return date;
}

function toDto(row: AuditLog): AuditEntryDto {
  return {
    id: row.id,
    occurred_at: row.at.toISOString(),
    tenant_id: row.tenantId,
    actor_type: row.actorType,
    actor_id: row.actorId,
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    ip: row.ip,
    changes: row.diff,
  };
}

@Controller('admin/v1/audit-log')
export class AuditLogController {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /** Newest first, scoped to the caller's tenant (FR-6). */
  @Get()
  @RequirePermission('identity:admin')
  async list(@Query() query: Record<string, unknown>, @CurrentPrincipal() principal: Principal): Promise<CursorPage<AuditEntryDto>> {
    // ponytail: platform operators (tenant_id null) have no cross-tenant view yet; add one when a task needs it.
    if (!principal.tenant_id) throw new ForbiddenException('audit log requires a tenant-scoped admin');

    const { cursor, limit } = parseCursorQuery(query, { defaultLimit: 50, maxLimit: 200 });
    const actorId = typeof query.actor_id === 'string' ? query.actor_id : undefined;
    const resourceType = typeof query.resource_type === 'string' ? query.resource_type : undefined;
    const from = parseDate(query.from, 'from');
    const to = parseDate(query.to, 'to');

    const filters: Prisma.AuditLogWhereInput[] = [];
    if (actorId) filters.push({ actorId });
    if (resourceType) filters.push({ resourceType });
    if (from || to) filters.push({ at: { gte: from, lt: to } });
    if (cursor) {
      const after = decodeCursor(cursor);
      filters.push({ OR: [{ at: { lt: new Date(after.at) } }, { at: new Date(after.at), id: { lt: after.id } }] });
    }

    // The `await` must happen inside the callback (see write-audit-entry.ts): Prisma's
    // `findMany()` only dispatches, and enters the tenant-scope extension, on `.then()`.
    const rows = await TenantContext.run(
      principal.tenant_id,
      async () =>
        await this.prisma.auditLog.findMany({
          where: filters.length ? { AND: filters } : {},
          orderBy: [{ at: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        })
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ at: last.at.toISOString(), id: last.id }) : null;

    return buildCursorPage(page.map(toDto), nextCursor);
  }
}
