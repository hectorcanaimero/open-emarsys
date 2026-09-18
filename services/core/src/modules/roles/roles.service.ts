import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { buildCursorPage, parseCursorQuery, type CursorPage } from '@oe/ts-common/http';
import { TenantContext } from '@oe/ts-common/tenant';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import type { RoleInput, RoleUpdateInput } from './dto.js';

export interface RoleDto {
  id: string;
  name: string;
  permissions: { module: string; action: string }[];
  created_at: string;
}

type RoleWithPermissions = Prisma.RoleGetPayload<{ include: { permissions: true } }>;

function toRoleDto(role: RoleWithPermissions): RoleDto {
  return {
    id: role.id,
    name: role.name,
    permissions: role.permissions.map((p) => ({ module: p.module, action: p.action })),
    created_at: role.createdAt.toISOString(),
  };
}

function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class RolesService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async list(tenantId: string, query: Record<string, unknown>): Promise<CursorPage<RoleDto>> {
    const { cursor, limit } = parseCursorQuery(query, { defaultLimit: 50, maxLimit: 200 });
    return TenantContext.run(tenantId, async () => {
      const rows = await this.prisma.role.findMany({
        where: cursor ? { id: { gt: decodeCursor(cursor) } } : {},
        orderBy: { id: 'asc' },
        take: limit + 1,
        include: { permissions: true },
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeCursor(page[page.length - 1]!.id) : null;
      return buildCursorPage(page.map(toRoleDto), nextCursor);
    });
  }

  async create(tenantId: string, input: RoleInput): Promise<RoleDto> {
    return TenantContext.run(tenantId, async () => {
      // Two flat creates inside `$transaction`, not a nested relational write: `withTenantScope`
      // only tenant-scopes top-level Prisma Client calls, and a nested write's child operation
      // would run outside that scoping.
      const role = await this.prisma
        .$transaction(async (tx) => {
          const created = await tx.role.create({ data: { tenantId, name: input.name } });
          if (input.permissions.length > 0) {
            await tx.rolePermission.createMany({
              data: input.permissions.map((p) => ({ roleId: created.id, tenantId, module: p.module, action: p.action })),
            });
          }
          return tx.role.findUniqueOrThrow({ where: { id: created.id }, include: { permissions: true } });
        })
        .catch((err) => {
          throw isUniqueViolation(err) ? new ConflictException('a role with this name already exists') : err;
        });
      return toRoleDto(role);
    });
  }

  async update(tenantId: string, id: string, input: RoleUpdateInput): Promise<RoleDto> {
    return TenantContext.run(tenantId, async () => {
      const role = await this.prisma.role.findUnique({ where: { id } });
      if (!role) throw new NotFoundException('role not found');

      const updated = await this.prisma
        .$transaction(async (tx) => {
          if (input.permissions !== undefined) {
            await tx.rolePermission.deleteMany({ where: { roleId: id } });
            if (input.permissions.length > 0) {
              await tx.rolePermission.createMany({
                data: input.permissions.map((p) => ({ roleId: id, tenantId, module: p.module, action: p.action })),
              });
            }
          }
          return tx.role.update({
            where: { id },
            data: input.name !== undefined ? { name: input.name } : {},
            include: { permissions: true },
          });
        })
        .catch((err) => {
          throw isUniqueViolation(err) ? new ConflictException('a role with this name already exists') : err;
        });
      return toRoleDto(updated);
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    return TenantContext.run(tenantId, async () => {
      const role = await this.prisma.role.findUnique({ where: { id } });
      if (!role) throw new NotFoundException('role not found');
      if (role.isDefault) throw new ConflictException('default roles cannot be deleted');
      const assigned = await this.prisma.userRole.count({ where: { roleId: id } });
      if (assigned > 0) throw new ConflictException('role is assigned to users');
      await this.prisma.role.delete({ where: { id } });
    });
  }
}
