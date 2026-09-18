import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentPrincipal, InternalOnly, type Principal, RequirePermission } from '@oe/ts-common/auth';
import { PublicApiError, PublicEnvelopeFilter, PublicEnvelopeInterceptor } from '@oe/ts-common/http';
import { fieldCreateSchema, fieldUpdateSchema, parseBody, publicFieldCreateSchema, snakeCase } from './dto.js';
import type { Choice } from './field-registry.js';
import { FieldsService, toFieldDto } from './fields.service.js';

function tenantOf(principal: Principal): string {
  if (!principal.tenant_id) throw new ForbiddenException('operator principals cannot manage tenant fields');
  return principal.tenant_id;
}

@Controller('admin/v1/fields')
export class FieldsController {
  constructor(private readonly fields: FieldsService) {}

  @Get()
  @RequirePermission('contacts:view')
  async list(@CurrentPrincipal() principal: Principal, @Query('include_deleted') includeDeleted?: string) {
    const rows = await this.fields.list(tenantOf(principal), includeDeleted === 'true');
    return { items: rows.map(toFieldDto) };
  }

  @Post()
  @RequirePermission('contacts:admin')
  async create(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return toFieldDto(await this.fields.create(tenantOf(principal), parseBody(fieldCreateSchema, body)));
  }

  @Patch(':fieldId')
  @RequirePermission('contacts:admin')
  async update(@CurrentPrincipal() principal: Principal, @Param('fieldId', ParseIntPipe) fieldId: number, @Body() body: unknown) {
    return toFieldDto(await this.fields.update(tenantOf(principal), fieldId, parseBody(fieldUpdateSchema, body)));
  }

  @Delete(':fieldId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('contacts:admin')
  async remove(@CurrentPrincipal() principal: Principal, @Param('fieldId', ParseIntPipe) fieldId: number): Promise<void> {
    await this.fields.remove(tenantOf(principal), fieldId);
  }
}

/** Public v3 (C2): same definitions, envelope, `name` and choice text in the tenant's locale. */
@Controller('api/v3/field')
@UseInterceptors(PublicEnvelopeInterceptor)
@UseFilters(PublicEnvelopeFilter)
export class PublicFieldsController {
  constructor(private readonly fields: FieldsService) {}

  @Get()
  @RequirePermission('contacts:view')
  async list(@CurrentPrincipal() principal: Principal) {
    const tenantId = tenantOf(principal);
    const locale = await this.fields.localeOf(tenantId);
    return (await this.fields.list(tenantId)).map((f) => publicField(f, locale));
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contacts:admin')
  async create(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const tenantId = tenantOf(principal);
    const b = parseBody(publicFieldCreateSchema, body);
    const created = await this.fields.create(tenantId, {
      api_name: b.string_id ?? snakeCase(b.name),
      type: b.application_type,
      labels: { es: b.name, pt: b.name, en: b.name },
      unique: b.unique,
      choices: b.choices.map((c) => ({ api_name: snakeCase(c), labels: { es: c, pt: c, en: c } })),
    });
    return publicField(created, await this.fields.localeOf(tenantId));
  }

  @Get(':id/choice')
  @RequirePermission('contacts:view')
  async choices(@CurrentPrincipal() principal: Principal, @Param('id', ParseIntPipe) id: number) {
    const tenantId = tenantOf(principal);
    const field = (await this.fields.list(tenantId)).find((f) => f.fieldId === id);
    if (!field) throw new PublicApiError(2011, `field ${id} does not exist`, HttpStatus.NOT_FOUND);
    if (!field.type.endsWith('_choice')) throw new PublicApiError(2010, `field ${id} has no choices`);
    const locale = await this.fields.localeOf(tenantId);
    return (field.choices as unknown as Choice[]).map((c) => ({ id: c.id, choice: c.labels[locale] }));
  }
}

/** Internal (C4, FR-12): field metadata for the importer's export; service tokens only, tenant in the query. */
@Controller('internal/v1/fields')
@InternalOnly()
export class InternalFieldsController {
  constructor(private readonly fields: FieldsService) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal, @Query('tenant_id') tenantId?: string) {
    if (!tenantId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new BadRequestException('tenant_id must be a UUID');
    }
    if (principal.tenant_id && principal.tenant_id !== tenantId) throw new ForbiddenException('tenant_id does not match the service token');
    return {
      default_locale: await this.fields.localeOf(tenantId),
      fields: (await this.fields.list(tenantId)).map((f) => ({
        field_id: f.fieldId,
        api_name: f.apiName,
        type: f.type,
        choices: (f.choices as unknown as Choice[]).map((c) => ({ id: c.id, labels: c.labels })),
      })),
    };
  }
}

function publicField(f: Parameters<typeof toFieldDto>[0], locale: 'es' | 'pt' | 'en') {
  return {
    id: f.fieldId,
    name: (f.labels as Record<string, string>)[locale],
    application_type: f.type,
    string_id: f.apiName,
  };
}
