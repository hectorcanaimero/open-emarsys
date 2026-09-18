import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentPrincipal, type Principal, RequirePermission } from '@oe/ts-common/auth';
import { parseBody, roleInputSchema, roleUpdateSchema } from './dto.js';
import { RolesService } from './roles.service.js';

function tenantOf(principal: Principal): string {
  if (!principal.tenant_id) throw new ForbiddenException('operator principals cannot manage tenant roles');
  return principal.tenant_id;
}

@Controller('admin/v1/roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('identity:view')
  list(@CurrentPrincipal() principal: Principal, @Query() query: Record<string, unknown>) {
    return this.roles.list(tenantOf(principal), query);
  }

  @Post()
  @RequirePermission('identity:admin')
  create(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return this.roles.create(tenantOf(principal), parseBody(roleInputSchema, body));
  }

  @Patch(':id')
  @RequirePermission('identity:admin')
  update(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.roles.update(tenantOf(principal), id, parseBody(roleUpdateSchema, body));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('identity:admin')
  async remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<void> {
    await this.roles.remove(tenantOf(principal), id);
  }
}
