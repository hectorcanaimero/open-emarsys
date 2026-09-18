import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { NatsPublisher } from '@oe/ts-common/nats';
import { withSystemScope } from '@oe/ts-common/prisma-tenant';
import type { Prisma, PrismaClient, Tenant } from '@prisma/client';
import { isCommonPassword } from '../users/common-passwords.js';
import { createDefaultTenantRoles } from './default-roles.js';
import { SYSTEM_PRISMA_CLIENT } from './system-prisma.module.js';
import type { TenantCreateInput, TenantLimits, TenantUpdateInput } from './tenants.schemas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantDto {
  id: string;
  name: string;
  timezone: string;
  default_locale: string;
  limits: TenantLimits;
  status: string;
  created_at: string;
}

export interface TenantPageResult {
  items: TenantDto[];
  nextCursor: string | null;
}

function toDto(tenant: Tenant): TenantDto {
  return {
    id: tenant.id,
    name: tenant.name,
    timezone: tenant.timezone,
    default_locale: tenant.defaultLocale,
    limits: (tenant.limits ?? {}) as TenantLimits,
    status: tenant.status,
    created_at: tenant.createdAt.toISOString(),
  };
}

/** Tenant management for the platform operator (FR-1). The only service in core that runs
 * every query `withSystemScope`: tenants and the roles created alongside them belong to no
 * tenant the caller is already scoped to. */
@Injectable()
export class TenantsService {
  constructor(
    @Inject(SYSTEM_PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly nats: NatsPublisher
  ) {}

  async list(cursor: string | undefined, limit: number): Promise<TenantPageResult> {
    const rows = await withSystemScope(() =>
      this.prisma.tenant.findMany({
        take: limit + 1,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { items: page.map(toDto), nextCursor: hasMore ? page[page.length - 1]!.id : null };
  }

  async get(id: string): Promise<TenantDto> {
    const tenant = await this.findOrThrow(id);
    return toDto(tenant);
  }

  async create(input: TenantCreateInput): Promise<TenantDto> {
    if (input.admin && isCommonPassword(input.admin.password)) {
      throw new BadRequestException({
        errors: [{ pointer: '/admin/password', detail: 'this password is too common' }],
      });
    }
    const adminPasswordHash = input.admin ? await hash(input.admin.password) : null;
    const tenant = await withSystemScope(() =>
      this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.tenant.create({
          data: {
            name: input.name,
            timezone: input.timezone,
            defaultLocale: input.default_locale,
            limits: input.limits ?? {},
          },
        });
        const adminRoleId = await createDefaultTenantRoles(tx, created.id);
        if (input.admin && adminPasswordHash) {
          const user = await tx.user.create({
            data: {
              tenantId: created.id,
              email: input.admin.email,
              passwordHash: adminPasswordHash,
              locale: input.default_locale,
              status: 'active',
            },
          });
          await tx.userRole.create({ data: { userId: user.id, roleId: adminRoleId, tenantId: created.id } });
        }
        return created;
      })
    );
    const dto = toDto(tenant);
    await this.nats.publish('system.tenant.created', tenant.id, null, dto);
    return dto;
  }

  async update(id: string, input: TenantUpdateInput): Promise<TenantDto> {
    await this.findOrThrow(id);
    const tenant = await withSystemScope(() =>
      this.prisma.tenant.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.default_locale !== undefined ? { defaultLocale: input.default_locale } : {}),
          ...(input.limits !== undefined ? { limits: input.limits } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      })
    );
    return toDto(tenant);
  }

  /** Used by login and API-token issuance (F0.6.T4/T6) to reject a suspended tenant with 403. */
  async assertActive(tenantId: string): Promise<void> {
    const tenant = await this.findOrThrow(tenantId);
    if (tenant.status === 'suspended') {
      throw new ForbiddenException('Tenant is suspended');
    }
  }

  private async findOrThrow(id: string): Promise<Tenant> {
    if (!UUID.test(id)) throw new NotFoundException('Tenant not found');
    const tenant = await withSystemScope(() => this.prisma.tenant.findUnique({ where: { id } }));
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant;
  }
}
