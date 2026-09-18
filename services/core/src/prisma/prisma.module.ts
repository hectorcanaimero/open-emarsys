import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';

/** A `PrismaClient` whose model operations run with `app.tenant_id` set (RLS, NFR-8). */
export const PRISMA_CLIENT = Symbol('oe:core:prisma-client');

/**
 * Global provider of the tenant-scoped Prisma client. Registered in AppModule by the
 * F0.6.T8 wiring task; feature module tests import it directly.
 */
@Global()
@Module({
  providers: [{ provide: PRISMA_CLIENT, useFactory: () => withTenantScope(new PrismaClient()) }],
  exports: [PRISMA_CLIENT],
})
export class PrismaModule implements OnModuleDestroy {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
