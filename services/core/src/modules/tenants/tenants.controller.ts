import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RequirePermission } from '@oe/ts-common/auth';
import { buildCursorPage, parseCursorQuery } from '@oe/ts-common/http';
import { OperatorOnlyGuard } from './operator-only.guard.js';
import { parseBody, tenantCreateSchema, tenantUpdateSchema } from './tenants.schemas.js';
import { TenantsService } from './tenants.service.js';

const PAGE_DEFAULTS = { defaultLimit: 50, maxLimit: 200 };

/** `contracts/openapi/admin-v1/identity.yaml` `tenants` tag: operator-only tenant CRUD (FR-1). */
@UseGuards(OperatorOnlyGuard)
@Controller('admin/v1/tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @RequirePermission('tenants:view')
  async list(@Query() query: Record<string, unknown>) {
    const { cursor, limit } = parseCursorQuery(query, PAGE_DEFAULTS);
    const page = await this.tenants.list(cursor, limit);
    return buildCursorPage(page.items, page.nextCursor);
  }

  @Post()
  @RequirePermission('tenants:admin')
  create(@Body() body: unknown) {
    return this.tenants.create(parseBody(tenantCreateSchema, body));
  }

  @Get(':id')
  @RequirePermission('tenants:view')
  get(@Param('id') id: string) {
    return this.tenants.get(id);
  }

  @Patch(':id')
  @RequirePermission('tenants:admin')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.tenants.update(id, parseBody(tenantUpdateSchema, body));
  }
}
