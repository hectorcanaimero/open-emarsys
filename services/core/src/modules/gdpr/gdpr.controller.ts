import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentPrincipal, type Principal, RequirePermission } from '@oe/ts-common/auth';
import { PublicApiError, PublicEnvelopeFilter, PublicEnvelopeInterceptor } from '@oe/ts-common/http';
import type { GdprRequestKind, GdprRequestStatus } from '@prisma/client';
import { z } from 'zod';
import { GdprService } from './gdpr.service.js';

const contactKey = z.object({
  key_id: z.union([z.string(), z.number().int()]).transform(String).pipe(z.string().regex(/^(id|[1-9]\d*)$/)),
  key_value: z.string().min(1),
});
const KINDS = ['export', 'forget'] as const;
const STATUSES = ['pending', 'running', 'done', 'failed'] as const;

function tenantOf(principal: Principal): string {
  if (!principal.tenant_id) throw new ForbiddenException('operator principals cannot manage tenant contacts');
  return principal.tenant_id;
}

function parseKey(body: unknown): z.infer<typeof contactKey> {
  const parsed = contactKey.safeParse(body);
  if (!parsed.success) throw new PublicApiError(1001, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], v?: string): T | undefined {
  if (v === undefined || v === '') return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new BadRequestException(`${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

/** Public v3 (C2, FR-15): `202` with the request's ID as `job_id`. */
@Controller('api/v3/gdpr')
@UseInterceptors(PublicEnvelopeInterceptor)
@UseFilters(PublicEnvelopeFilter)
export class PublicGdprController {
  constructor(private readonly gdpr: GdprService) {}

  @Post('export')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('contacts:admin')
  export(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return this.request(principal, body, 'export');
  }

  @Post('forget')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('contacts:admin')
  forget(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return this.request(principal, body, 'forget');
  }

  private async request(principal: Principal, body: unknown, kind: GdprRequestKind) {
    const b = parseKey(body);
    return { job_id: (await this.gdpr.requestByKey(tenantOf(principal), b.key_id, b.key_value, kind, principal.sub)).id };
  }
}

/** Console (C3); the UI asks twice before calling `forget`. */
@Controller('admin/v1')
export class AdminGdprController {
  constructor(private readonly gdpr: GdprService) {}

  @Post('contacts/:id/gdpr/export')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('contacts:admin')
  export(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.gdpr.request(tenantOf(principal), id, 'export', principal.sub);
  }

  @Post('contacts/:id/gdpr/forget')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('contacts:admin')
  forget(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.gdpr.request(tenantOf(principal), id, 'forget', principal.sub);
  }

  @Get('gdpr-requests')
  @RequirePermission('contacts:admin')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ) {
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequestException('limit must be between 1 and 200');
    return this.gdpr.list(tenantOf(principal), {
      kind: oneOf<GdprRequestKind>('kind', KINDS, kind),
      status: oneOf<GdprRequestStatus>('status', STATUSES, status),
      cursor: cursor || undefined,
      limit: n,
    });
  }
}
