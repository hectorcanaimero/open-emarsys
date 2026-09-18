import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentPrincipal, InternalOnly, type Principal, RequirePermission } from '@oe/ts-common/auth';
import { PublicApiError, PublicEnvelopeFilter, PublicEnvelopeInterceptor } from '@oe/ts-common/http';
import type { Contact } from '@prisma/client';
import { z } from 'zod';
import { parseBody } from '../fields/dto.js';
import { ContactsWriteService, type ItemError, type ItemResult, type WriteMode } from './contacts-write.service.js';

const MAX_BATCH = 1000;
const keyId = z.union([z.string(), z.number().int()]).transform(String).pipe(z.string().regex(/^(id|[1-9]\d*)$/));
const fieldValues = z.record(z.string().regex(/^[1-9]\d*$/), z.unknown());
const items = z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_BATCH);

const publicBatch = z.object({ key_id: keyId, contacts: items });
const internalBatch = z.object({
  tenant_id: z.string().uuid(),
  key_id: keyId,
  mode: z.enum(['create', 'update', 'upsert']),
  source: z.string().min(1).default('import'),
  contacts: items,
});
const internalFields = z.object({ tenant_id: z.string().uuid(), fields: fieldValues, source: z.string().min(1).default('api') });
const contactWrite = z.object({ fields: fieldValues });

function tenantOf(principal: Principal): string {
  if (!principal.tenant_id) throw new ForbiddenException('operator principals cannot write tenant contacts');
  return principal.tenant_id;
}

/** C4 names the tenant in the body; a service token bound to a tenant may only write that one. */
function internalTenant(principal: Principal, tenantId: string): string {
  if (principal.tenant_id && principal.tenant_id !== tenantId) throw new ForbiddenException('tenant_id does not match the service token');
  return tenantId;
}

/** Item error of a single-contact write, as an HTTP error. */
function httpError(e: ItemError): Error {
  if (e.code === 2008) return new NotFoundException(e.text);
  if (e.code === 2012) return new ConflictException(e.text);
  return new BadRequestException({ errors: [{ pointer: e.field_id ? `fields/${e.field_id}` : '', detail: e.text, code: e.code }] });
}

function toContactDto(c: Contact) {
  return { id: c.id, fields: c.data, version: Number(c.version), created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString() };
}

/** Public v3 `ContactBatch` data: processed IDs in request order and per-item errors (FR-8). */
function batchData(results: ItemResult[]) {
  return {
    ids: results.flatMap((r) => (r.id ? [r.id] : [])),
    errors: results.flatMap((r) => (r.error ? [{ index: r.index, key: r.key, code: r.error.code, text: r.error.text }] : [])),
  };
}

function parsePublicBatch(body: unknown): z.infer<typeof publicBatch> {
  const contacts = (body as { contacts?: unknown } | null)?.contacts;
  if (Array.isArray(contacts) && contacts.length > MAX_BATCH) throw new PublicApiError(1002, `at most ${MAX_BATCH} contacts per request`);
  const parsed = publicBatch.safeParse(body);
  if (!parsed.success) throw new PublicApiError(1001, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}

/** C2: `POST` creates, `PUT` updates; `create_if_not_exists=1` makes either an upsert. */
@Controller('api/v3/contact')
@UseInterceptors(PublicEnvelopeInterceptor)
@UseFilters(PublicEnvelopeFilter)
export class PublicContactsWriteController {
  constructor(private readonly contacts: ContactsWriteService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  create(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @Query('create_if_not_exists') upsert?: string) {
    return this.run(principal, body, upsert === '1' ? 'upsert' : 'create');
  }

  @Put()
  @RequirePermission('contacts:edit')
  update(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @Query('create_if_not_exists') upsert?: string) {
    return this.run(principal, body, upsert === '1' ? 'upsert' : 'update');
  }

  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  async remove(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const b = parsePublicBatch(body);
    return batchData(await this.contacts.delete(tenantOf(principal), b.key_id, b.contacts));
  }

  private async run(principal: Principal, body: unknown, mode: WriteMode) {
    const b = parsePublicBatch(body);
    return batchData(await this.contacts.write(tenantOf(principal), b.key_id, mode, b.contacts));
  }
}

/** C3: one contact by ID; audited by the global `AuditInterceptor`. */
@Controller('admin/v1/contacts')
export class AdminContactsWriteController {
  constructor(private readonly contacts: ContactsWriteService) {}

  @Patch(':id')
  @RequirePermission('contacts:edit')
  async update(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    const tenantId = tenantOf(principal);
    const [r] = await this.contacts.write(tenantId, 'id', 'update', [{ ...parseBody(contactWrite, body).fields, id }]);
    if (r!.error) throw httpError(r!.error);
    return toContactDto(await this.contacts.get(tenantId, id));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('contacts:edit')
  async remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<void> {
    const [r] = await this.contacts.delete(tenantOf(principal), 'id', [{ id }]);
    if (r!.error) throw httpError(r!.error);
  }
}

/** C4: the same engine for importer and other services, in the tenant named by the body. */
@Controller('internal/v1/contacts')
@InternalOnly()
export class InternalContactsWriteController {
  constructor(private readonly contacts: ContactsWriteService) {}

  @Post('batch-upsert')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  async batchUpsert(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const b = parseBody(internalBatch, body);
    const results = await this.contacts.write(internalTenant(principal, b.tenant_id), b.key_id, b.mode, b.contacts, b.source);
    return { results: results.map((r) => ({ index: r.index, id: r.id, created: r.created, ...(r.error ? { error: r.error } : {}) })) };
  }

  @Post(':id/fields')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:edit')
  async setFields(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parseBody(internalFields, body);
    const tenantId = internalTenant(principal, b.tenant_id);
    const [r] = await this.contacts.write(tenantId, 'id', 'update', [{ ...b.fields, id }], b.source);
    if (r!.error) throw httpError(r!.error);
    return { id, version: Number((await this.contacts.get(tenantId, id)).version), changed: r!.changed };
  }
}
