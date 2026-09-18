import 'reflect-metadata';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditModule } from '@oe/ts-common/audit';
import { AuthModule, LocalKeyVerifier } from '@oe/ts-common/auth';
import { ProblemJsonFilter } from '@oe/ts-common/http';
import { NatsModule } from '@oe/ts-common/nats';
import type { CoreConfig } from './main.js';
import { HealthModule } from './modules/health/health.module.js';

/**
 * Cross-cutting wiring only (C11): auth guard, NATS, problem+json and audit.
 * Feature modules (tenants, auth, users, ...) are registered by the F0.6.T8
 * wiring task once they exist.
 */
@Module({})
export class AppModule {
  static forRoot(config: CoreConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        NatsModule.forRoot({ servers: config.NATS_URL, source: 'core' }),
        // No signing keys exist yet (F0.6.T4 loads CORE_JWT_KEYS_DIR): an empty
        // key set rejects every token, which is correct until auth is wired.
        AuthModule.forRoot({ verifier: new LocalKeyVerifier({ keys: [] }, config.CORE_JWT_ISSUER) }),
        AuditModule.forRoot(),
        HealthModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemJsonFilter }],
    };
  }
}
