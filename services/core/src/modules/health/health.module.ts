import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { HealthController } from './health.controller.js';
import { PG_POOL } from './tokens.js';

/**
 * Readiness only needs to know Postgres answers, so it pings it with a plain pool.
 * The tenant-scoped Prisma client (`withTenantScope` from @oe/ts-common/prisma-tenant)
 * arrives with the first models in F0.6.T2: Prisma will not generate a client for a
 * schema that has none.
 */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
        // An idle client dies when Postgres restarts, and an unhandled 'error' event would
        // take the whole process down. The pool drops that client; readyz reports the
        // outage on its next query.
        pool.on('error', () => {});
        return pool;
      },
    },
  ],
})
export class HealthModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
