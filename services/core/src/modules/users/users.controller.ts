import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentPrincipal, type Principal, RequirePermission } from '@oe/ts-common/auth';
import { inviteUserSchema, parseBody, updateUserSchema } from './dto.js';
import { InvitationsService } from './invitations.service.js';
import { UsersService } from './users.service.js';

function tenantOf(principal: Principal): string {
  if (!principal.tenant_id) throw new ForbiddenException('operator principals cannot manage tenant users');
  return principal.tenant_id;
}

@Controller('admin/v1/users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly invitations: InvitationsService
  ) {}

  @Get()
  @RequirePermission('identity:view')
  list(@CurrentPrincipal() principal: Principal, @Query() query: Record<string, unknown>) {
    return this.users.list(tenantOf(principal), query);
  }

  @Post('invitations')
  @RequirePermission('identity:admin')
  invite(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const input = parseBody(inviteUserSchema, body);
    return this.invitations.invite(tenantOf(principal), principal.sub, input);
  }

  @Patch(':id')
  @RequirePermission('identity:admin')
  update(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(updateUserSchema, body);
    return this.users.update(tenantOf(principal), id, input);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('identity:admin')
  async remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<void> {
    await this.users.remove(tenantOf(principal), id);
  }
}
