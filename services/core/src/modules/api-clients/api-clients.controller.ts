import { Body, Controller, ForbiddenException, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentPrincipal, type Principal, RequirePermission } from '@oe/ts-common/auth';
import { parseBody } from '../roles/dto.js';
import { apiClientInput, ApiClientsService } from './api-clients.service.js';

function tenantOf(principal: Principal): string {
  if (!principal.tenant_id) throw new ForbiddenException('operator principals cannot manage tenant API clients');
  return principal.tenant_id;
}

@Controller('admin/v1/api-clients')
export class ApiClientsController {
  constructor(private readonly clients: ApiClientsService) {}

  @Get()
  @RequirePermission('identity:admin')
  list(@CurrentPrincipal() principal: Principal, @Query() query: Record<string, unknown>) {
    return this.clients.list(tenantOf(principal), query);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @RequirePermission('identity:admin')
  create(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return this.clients.create(tenantOf(principal), parseBody(apiClientInput, body));
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermission('identity:admin')
  revoke(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.clients.revoke(tenantOf(principal), id);
  }
}
