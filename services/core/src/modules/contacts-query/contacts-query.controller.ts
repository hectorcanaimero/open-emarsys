import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentPrincipal, InternalOnly, type Principal, RequirePermission } from '@oe/ts-common/auth';
import { PublicEnvelopeFilter, PublicEnvelopeInterceptor } from '@oe/ts-common/http';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { parseBody } from '../fields/dto.js';
import { ContactStreamService } from './contact-stream.service.js';
import { ContactsQueryService, DEFAULT_FIELDS, inTenant, parseFieldIds } from './contacts-query.service.js';

function tenantOf(principal: Principal): string {
  if (!principal.tenant_id) throw new ForbiddenException('operator principals cannot read tenant contacts');
  return principal.tenant_id;
}

const fieldId = z.string().regex(/^[1-9]\d*$/).transform(Number);
const getDataSchema = z.object({
  keyId: z.string().regex(/^([0-9]+|id)$/),
  keyValues: z.array(z.string()).min(1).max(1000),
  fields: z.array(fieldId).min(1).max(500),
});
const lookupSchema = z.object({
  tenant_id: z.string().uuid(),
  contact_ids: z.array(z.string().uuid()).min(1).max(5000),
  field_ids: z.array(z.number().int().min(1)).min(1).max(500),
});

/** Public v3 (C2, FR-9). */
@Controller('api/v3/contact')
@UseInterceptors(PublicEnvelopeInterceptor)
@UseFilters(PublicEnvelopeFilter)
export class PublicContactsQueryController {
  constructor(private readonly contacts: ContactsQueryService) {}

  @Post('getdata')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:view')
  getData(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const b = parseBody(getDataSchema, body);
    return inTenant(tenantOf(principal), () => this.contacts.getData(b.keyId, b.keyValues, [...new Set(b.fields)]));
  }
}

/** Console (C3, FR-10). */
@Controller('admin/v1/contacts')
export class AdminContactsQueryController {
  constructor(private readonly contacts: ContactsQueryService) {}

  @Get()
  @RequirePermission('contacts:view')
  search(
    @CurrentPrincipal() principal: Principal,
    @Query('q') q?: string,
    @Query('filters') filters?: string | string[],
    @Query('fields') fields?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ) {
    const list = filters === undefined ? [] : Array.isArray(filters) ? filters : [filters];
    if (list.length > 10) throw new BadRequestException('at most 10 filters');
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequestException('limit must be between 1 and 200');
    const ids = parseFieldIds(fields, DEFAULT_FIELDS);
    return inTenant(tenantOf(principal), () => this.contacts.search({ q: q || undefined, filters: list, fields: ids, cursor: cursor || undefined, limit: n }));
  }

  @Get(':id')
  @RequirePermission('contacts:view')
  profile(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return inTenant(tenantOf(principal), () => this.contacts.profile(id));
  }
}

/** Internal (C4, FR-12): service tokens only; the tenant comes in the request. */
@Controller('internal/v1/contacts')
@InternalOnly()
export class InternalContactsQueryController {
  constructor(
    private readonly contacts: ContactsQueryService,
    private readonly stream: ContactStreamService
  ) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  async lookup(@Body() body: unknown) {
    const b = parseBody(lookupSchema, body);
    return { contacts: await inTenant(b.tenant_id, () => this.contacts.lookup(b.contact_ids, [...new Set(b.field_ids)])) };
  }

  @Get('stream')
  async export(
    @Res() res: ServerResponse,
    @Query('tenant_id') tenantId?: string,
    @Query('fields') fields?: string,
    @Query('list_id') listId?: string
  ): Promise<void> {
    const ids = parseFieldIds(fields);
    if (listId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(listId)) {
      throw new BadRequestException('list_id must be a UUID');
    }
    await inTenant(tenantId, async () => {
      if (listId && !(await this.stream.listExists(tenantId as string, listId))) throw new NotFoundException('list not found');
      res.writeHead(HttpStatus.OK, { 'content-type': 'application/x-ndjson' });
      try {
        await this.stream.stream(tenantId as string, ids, listId, res);
        res.end();
      } catch {
        // Headers are out: cut the connection so the client sees a truncated body, as the contract says.
        res.destroy();
      }
    });
  }
}
