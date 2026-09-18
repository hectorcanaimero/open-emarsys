import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { buildCursorPage, parseCursorQuery, type CursorPage } from '@oe/ts-common/http';
import { TenantContext } from '@oe/ts-common/tenant';
import type { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import type { UpdateUserInput } from './dto.js';
import { decodeCursor, encodeCursor, toUserDto, type UserDto } from './user.mapper.js';

/** The one role every tenant gets at creation (F0.6.T3) that "last Admin" protection tracks. */
const ADMIN_ROLE_NAME = 'Admin';

@Injectable()
export class UsersService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async list(tenantId: string, query: Record<string, unknown>): Promise<CursorPage<UserDto>> {
    const { cursor, limit } = parseCursorQuery(query, { defaultLimit: 50, maxLimit: 200 });
    const email = typeof query.email === 'string' && query.email.length > 0 ? query.email : undefined;

    return TenantContext.run(tenantId, async () => {
      const rows = await this.prisma.user.findMany({
        where: {
          ...(cursor ? { id: { gt: decodeCursor(cursor) } } : {}),
          ...(email ? { email: { contains: email, mode: 'insensitive' as const } } : {}),
        },
        orderBy: { id: 'asc' },
        take: limit + 1,
        include: { roles: true },
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeCursor(page[page.length - 1]!.id) : null;
      return buildCursorPage(page.map(toUserDto), nextCursor);
    });
  }

  async update(tenantId: string, id: string, input: UpdateUserInput): Promise<UserDto> {
    return TenantContext.run(tenantId, async () => {
      const user = await this.prisma.user.findUnique({ where: { id }, include: { roles: true } });
      if (!user) throw new NotFoundException('user not found');

      if (input.role_ids !== undefined) await this.assertRolesBelongToTenant(tenantId, input.role_ids);

      const currentlyAdmin = await this.hasAdminRole(
        tenantId,
        user.roles.map((r) => r.roleId)
      );
      const losesRole = input.role_ids !== undefined && !(await this.hasAdminRole(tenantId, input.role_ids));
      const disabling = input.status === 'disabled';
      if (currentlyAdmin && (losesRole || disabling)) await this.assertNotLastAdmin(tenantId, id);

      const updated = await this.prisma.$transaction(async (tx) => {
        if (input.role_ids !== undefined) {
          await tx.userRole.deleteMany({ where: { userId: id } });
          if (input.role_ids.length > 0) {
            await tx.userRole.createMany({
              data: input.role_ids.map((roleId) => ({ userId: id, roleId, tenantId })),
            });
          }
        }
        return tx.user.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.status !== undefined
              ? { status: input.status, ...(input.status === 'active' ? { failedLogins: 0, lockedUntil: null } : {}) }
              : {}),
          },
          include: { roles: true },
        });
      });
      return toUserDto(updated);
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    return TenantContext.run(tenantId, async () => {
      const user = await this.prisma.user.findUnique({ where: { id }, include: { roles: true } });
      if (!user) throw new NotFoundException('user not found');
      if (await this.hasAdminRole(tenantId, user.roles.map((r) => r.roleId))) {
        await this.assertNotLastAdmin(tenantId, id);
      }
      await this.prisma.user.delete({ where: { id } });
    });
  }

  private async hasAdminRole(tenantId: string, roleIds: string[]): Promise<boolean> {
    if (roleIds.length === 0) return false;
    const adminRole = await this.prisma.role.findFirst({
      where: { tenantId, isDefault: true, name: ADMIN_ROLE_NAME },
    });
    return adminRole !== null && roleIds.includes(adminRole.id);
  }

  /** Blocks the change when it would leave zero active users holding the Admin role. */
  private async assertNotLastAdmin(tenantId: string, changingUserId: string): Promise<void> {
    const adminRole = await this.prisma.role.findFirst({
      where: { tenantId, isDefault: true, name: ADMIN_ROLE_NAME },
    });
    if (!adminRole) return;
    const otherActiveAdmins = await this.prisma.userRole.count({
      where: { roleId: adminRole.id, userId: { not: changingUserId }, user: { status: 'active' } },
    });
    if (otherActiveAdmins === 0) throw new ConflictException('cannot remove the last Admin of the tenant');
  }

  private async assertRolesBelongToTenant(tenantId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return;
    const count = await this.prisma.role.count({ where: { tenantId, id: { in: roleIds } } });
    if (count !== roleIds.length) throw new NotFoundException('one or more roles not found');
  }
}
