import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { PrismaClient } from '@prisma/client';

/**
 * Postgres role `core` switches into via `SET LOCAL ROLE` (granted BYPASSRLS in
 * `deploy/postgres/init/00-roles.sql`). Tenants themselves, and the platform operator's
 * own rows, have no tenant to scope by (`tenants.id` isn't known before insert; `tenant_id`
 * is null for the operator), so the `tenant_isolation` RLS policies would otherwise block
 * this module's reads and writes entirely — `NULL` never equals a session's `app.tenant_id`.
 */
export const SYSTEM_DB_ROLE = 'core_system';

export const SYSTEM_PRISMA_CLIENT = Symbol('oe:core:tenants:system-prisma-client');

/**
 * Dedicated connection for the tenants module: the only place in core that calls
 * `withSystemScope` (FR-1), kept separate from the tenant-scoped `PRISMA_CLIENT` in
 * `src/prisma/` so that client never needs a bypass role.
 */
@Module({
  providers: [
    {
      provide: SYSTEM_PRISMA_CLIENT,
      useFactory: () => withTenantScope(new PrismaClient(), { systemRole: SYSTEM_DB_ROLE }),
    },
  ],
  exports: [SYSTEM_PRISMA_CLIENT],
})
export class SystemPrismaModule implements OnModuleDestroy {
  constructor(@Inject(SYSTEM_PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
