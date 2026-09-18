import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, UseFilters, UseInterceptors } from '@nestjs/common';
import { CurrentPrincipal, type Principal, RequirePermission } from '@oe/ts-common/auth';
import { PublicApiError, PublicEnvelopeFilter, PublicEnvelopeInterceptor } from '@oe/ts-common/http';
import { TenantContext } from '@oe/ts-common/tenant';
import { z } from 'zod';
import { parseBody } from '../fields/dto.js';
import { KeyResolver } from '../fields/key-resolver.js';
import { ConsentsService } from './consents.service.js';

const channel = z.enum(['email', 'sms', 'push']);
const value = z.union([z.literal(1), z.literal(2), z.null()]);
const source = z.string().min(1).max(100);
const text = z.string().max(5000).optional();
const keyId = z.union([z.string(), z.number().int()]).transform(String).pipe(z.string().regex(/^(id|[1-9]\d*)$/));

const publicBody = z.object({ key_id: keyId, key_value: z.union([z.string(), z.number()]).transform(String), channel, value, source, text });
const adminBody = z.object({ channel, value, source, text });
const listQuery = z.object({ channel: channel.optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

function tenantOf(p: Principal): string {
  if (!p.tenant_id) throw new ForbiddenException('operator principals cannot write tenant contacts');
  return p.tenant_id;
}
const actorOf = (p: Principal) => `${p.typ}:${p.sub}`;

/** C2 `POST /contact/consent`. */
@Controller('api/v3/contact/consent')
@UseInterceptors(PublicEnvelopeInterceptor)
@UseFilters(PublicEnvelopeFilter)
export class PublicConsentsController {
  constructor(
    private readonly consents: ConsentsService,
    private readonly keys: KeyResolver
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  async set(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const parsed = publicBody.safeParse(body);
    if (!parsed.success) throw new PublicApiError(1001, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const { key_id, key_value, ...input } = parsed.data;
    const tenantId = tenantOf(principal);
    const id = key_id === 'id' ? key_value : await TenantContext.run(tenantId, async () => (await this.keys.resolve(key_id, [key_value])).get(key_value));
    if (!id) throw new PublicApiError(2008, 'contact not found', HttpStatus.NOT_FOUND);
    try {
      await this.consents.set(tenantId, id, { ...input, actor: actorOf(principal) });
    } catch (e) {
      throw e instanceof NotFoundException ? new PublicApiError(2008, 'contact not found', HttpStatus.NOT_FOUND) : e;
    }
    return { id };
  }
}

/** C3 `/admin/v1/contacts/{id}/consents`. */
@Controller('admin/v1/contacts/:id/consents')
export class AdminConsentsController {
  constructor(private readonly consents: ConsentsService) {}

  @Get()
  @RequirePermission('contacts:view')
  list(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Query() query: unknown) {
    const q = parseBody(listQuery, query);
    return this.consents.history(tenantOf(principal), id, q.channel, q.limit, q.cursor);
  }

  @Post()
  @RequirePermission('contacts:edit')
  async record(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parseBody(adminBody, body);
    const tenantId = tenantOf(principal);
    await this.consents.set(tenantId, id, { ...b, actor: actorOf(principal) });
    return (await this.consents.history(tenantId, id, b.channel, 1)).items[0];
  }
}
