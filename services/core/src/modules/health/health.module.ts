import { Global, Module } from '@nestjs/common';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { PrismaClient } from '@prisma/client';
import { HealthController } from './health.controller.js';
import { PRISMA_CLIENT } from './tokens.js';

/**
 * Global so every future feature module can `@Inject(PRISMA_CLIENT)` the same
 * tenant-scoped client without re-declaring it (only this task edits
 * `app.module.ts` before the F0.6.T8 wiring task, C11).
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [{ provide: PRISMA_CLIENT, useFactory: () => withTenantScope(new PrismaClient()) }],
  exports: [PRISMA_CLIENT],
})
export class HealthModule {}
