import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseFilters, UseInterceptors } from '@nestjs/common';
import { CurrentPrincipal, InternalOnly, type Principal, RequirePermission } from '@oe/ts-common/auth';
import { PublicApiError, PublicEnvelopeFilter, PublicEnvelopeInterceptor } from '@oe/ts-common/http';
import { z } from 'zod';
import { parseBody } from '../fields/dto.js';
import { ListsService } from './lists.service.js';

const PUBLIC_MAX = 1000;
const INTERNAL_MAX = 10_000;
const keyId = z.union([z.string(), z.number().int()]).transform(String).pipe(z.string().regex(/^(id|[1-9]\d*)$/));
const uuid = z.string().uuid();
const description = z.string().max(1000).nullable().optional();

const listInput = z.object({ name: z.string().min(1).max(200), description });
const listUpdate = z.object({ name: z.string().min(1).max(200).optional(), description }).refine((v) => v.name !== undefined || v.description !== undefined, {
  message: 'at least one property is required',
});
const contactIds = z.object({ contact_ids: z.array(uuid).min(1).max(INTERNAL_MAX) });
const internalMembers = z.object({ tenant_id: uuid, key_id: keyId, key_values: z.array(z.string()).min(1).max(INTERNAL_MAX) });

function tenantOf(principal: Principal): string {
  if (!principal.tenant_id) throw new ForbiddenException('operator principals cannot use tenant lists');
  return principal.tenant_id;
}

/** Public v3 body: shape errors are 1001 and an oversized array 1002, like `/contact`. */
function parsePublic<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const ids = (body as { external_ids?: unknown } | null)?.external_ids;
  if (Array.isArray(ids) && ids.length > PUBLIC_MAX) throw new PublicApiError(1002, `at most ${PUBLIC_MAX} external_ids per request`);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new PublicApiError(1001, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}

const publicMembers = z.object({ key_id: keyId, external_ids: z.array(z.string()).min(1) });
const publicCreate = z.object({ name: z.string().min(1).max(200), key_id: keyId.optional(), external_ids: z.array(z.string()).optional() });

/** C2 (FR-13): lists and their members addressed by `key_id` + values. */
@Controller('api/v3/contactlist')
@UseInterceptors(PublicEnvelopeInterceptor)
@UseFilters(PublicEnvelopeFilter)
export class PublicListsController {
  constructor(private readonly lists: ListsService) {}

  @Get()
  @RequirePermission('contacts:view')
  async list(@CurrentPrincipal() principal: Principal) {
    const tenantId = tenantOf(principal);
    const out = [];
    let cursor: string | undefined;
    do {
      const page = await this.lists.list(tenantId, { limit: '200', cursor });
      out.push(...page.items.map((l) => ({ id: l.id, name: l.name, created: l.created_at })));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  async create(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const b = parsePublic(publicCreate, body);
    if (b.external_ids?.length && !b.key_id) throw new PublicApiError(1001, 'key_id is required with external_ids');
    const tenantId = tenantOf(principal);
    const list = await this.lists.create(tenantId, b.name).catch((err: { status?: number; message: string }) => {
      throw err.status === HttpStatus.CONFLICT ? new PublicApiError(2012, err.message) : err;
    });
    const errors = b.external_ids?.length ? (await this.lists.addByKeys(tenantId, list.id, b.key_id!, b.external_ids)).errors : [];
    return { id: list.id, errors };
  }

  @Post(':id/add')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  async add(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parsePublic(publicMembers, body);
    const r = await this.lists.addByKeys(tenantOf(principal), id, b.key_id, b.external_ids);
    return { count: r.changed, errors: r.errors };
  }

  @Post(':id/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  async remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parsePublic(publicMembers, body);
    const r = await this.lists.removeByKeys(tenantOf(principal), id, b.key_id, b.external_ids);
    return { count: r.changed, errors: r.errors };
  }

  @Get(':id/count')
  @RequirePermission('contacts:view')
  async count(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return { count: await this.lists.count(tenantOf(principal), id) };
  }
}

/** C3: list CRUD and membership by contact ID; audited by the global `AuditInterceptor`. */
@Controller('admin/v1')
export class AdminListsController {
  constructor(private readonly lists: ListsService) {}

  @Get('lists')
  @RequirePermission('contacts:view')
  list(@CurrentPrincipal() principal: Principal, @Query() query: Record<string, unknown>) {
    return this.lists.list(tenantOf(principal), query);
  }

  @Post('lists')
  @RequirePermission('contacts:edit')
  create(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return this.lists.create(tenantOf(principal), parseBody(listInput, body).name);
  }

  @Get('lists/:id')
  @RequirePermission('contacts:view')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.lists.get(tenantOf(principal), id);
  }

  @Patch('lists/:id')
  @RequirePermission('contacts:edit')
  update(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.lists.rename(tenantOf(principal), id, parseBody(listUpdate, body).name);
  }

  @Delete('lists/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('contacts:edit')
  remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.lists.remove(tenantOf(principal), id);
  }

  @Get('lists/:id/members')
  @RequirePermission('contacts:view')
  members(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.lists.members(tenantOf(principal), id, query);
  }

  @Post('lists/:id/members')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  addMembers(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.lists.addContacts(tenantOf(principal), id, parseBody(contactIds, body).contact_ids);
  }

  @Delete('lists/:id/members')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  removeMembers(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.lists.removeContacts(tenantOf(principal), id, parseBody(contactIds, body).contact_ids);
  }

  @Get('contacts/:id/lists')
  @RequirePermission('contacts:view')
  listsOf(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.lists.listsOf(tenantOf(principal), id, query);
  }
}

/** C4: bulk membership for the importer, in the tenant named by the body. */
@Controller('internal/v1/lists')
@InternalOnly()
export class InternalListsController {
  constructor(private readonly lists: ListsService) {}

  @Post(':id/members')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  async add(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parseBody(internalMembers, body);
    if (principal.tenant_id && principal.tenant_id !== b.tenant_id) throw new ForbiddenException('tenant_id does not match the service token');
    const r = await this.lists.addByKeys(b.tenant_id, id, b.key_id, b.key_values);
    return { added: r.changed, errors: r.errors };
  }
}
