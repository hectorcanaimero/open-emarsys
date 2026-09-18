import 'reflect-metadata';
import {
  type ArgumentsHost,
  Catch,
  type DynamicModule,
  HttpException,
  InternalServerErrorException,
  Logger,
  Module,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { type AuditEntry, AuditInterceptor, AuditSink } from '@oe/ts-common/audit';
import { AuthModule } from '@oe/ts-common/auth';
import { loadConfig } from '@oe/ts-common/config';
import { ProblemJsonFilter } from '@oe/ts-common/http';
import { NatsModule } from '@oe/ts-common/nats';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { CoreConfig } from './main.js';
import { ApiClientsModule } from './modules/api-clients/api-clients.module.js';
import { CoreAuditModule, PostgresAuditSink } from './modules/audit/audit.module.js';
import { IdentityAuthModule, JwtSigner } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { OAuthModule, OAuthService, RevocationAwareVerifier } from './modules/oauth/oauth.module.js';
import { RolesModule } from './modules/roles/roles.module.js';
import { SYSTEM_DB_ROLE, SYSTEM_PRISMA_CLIENT, SystemPrismaModule, TenantsModule } from './modules/tenants/index.js';
import { UsersModule } from './modules/users/users.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

/** Secrets the identity modules need on top of `CoreConfig` (D7, NFR-9). */
export const identityConfigSchema = z.object({
  /** Directory of `<kid>.pem` RS256 private keys; the last `kid` signs. */
  CORE_JWT_KEYS_DIR: z.string().min(1),
  /** 32 bytes, base64: seals TOTP secrets. */
  CORE_ENCRYPTION_KEY: z.string().min(1),
  /** JSON file with per-service credentials for `/internal/v1/service-token`. */
  CORE_SERVICE_CREDENTIALS: z.string().min(1),
});
export type IdentityConfig = z.infer<typeof identityConfigSchema>;

/**
 * Unexpected errors keep their message server-side: Prisma's carries source paths, code
 * frames and SQL errors, which `ProblemJsonFilter` would otherwise send as `detail`.
 */
@Catch()
class CoreProblemJsonFilter extends ProblemJsonFilter {
  private readonly logger = new Logger('HTTP');

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) return super.catch(exception, host);
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    super.catch(new InternalServerErrorException(), host);
  }
}

/**
 * `PostgresAuditSink` over the system-role client, because operator entries (`tenant_id`
 * null) fail the `audit_log` RLS policy without it. `AuditInterceptor` doesn't await
 * `record`, so a failed write is logged here instead of becoming an unhandled rejection.
 */
class CoreAuditSink extends PostgresAuditSink {
  private readonly logger = new Logger('Audit');

  override async record(entry: AuditEntry): Promise<void> {
    await super.record(entry).catch((err: unknown) => this.logger.error(`audit write failed: ${String(err)}`));
  }
}

/** Cross-cutting wiring (C11) plus the identity feature modules of F0.6. */
@Module({})
export class AppModule {
  static forRoot(config: CoreConfig, identity: IdentityConfig = loadConfig(identityConfigSchema)): DynamicModule {
    const signer = JwtSigner.fromDir(identity.CORE_JWT_KEYS_DIR, config.CORE_JWT_ISSUER);
    // The guard's verifier is built before Nest instantiates OAuthService; the factory
    // below hands it over once it exists, so core rejects revoked clients' tokens (FR-4).
    let oauth: OAuthService | undefined;
    const verifier = new RevocationAwareVerifier(signer.verifier(), async (id) => (oauth ? oauth.isRevoked(id) : true));

    return {
      module: AppModule,
      imports: [
        NatsModule.forRoot({ servers: config.NATS_URL, source: 'core' }),
        AuthModule.forRoot({ verifier }),
        PrismaModule,
        HealthModule,
        SystemPrismaModule,
        TenantsModule,
        IdentityAuthModule.forRoot({ signer, encryptionKey: identity.CORE_ENCRYPTION_KEY, systemRole: SYSTEM_DB_ROLE }),
        UsersModule,
        RolesModule,
        ApiClientsModule,
        OAuthModule.forRoot({
          signer,
          systemRole: SYSTEM_DB_ROLE,
          serviceCredentialsFile: identity.CORE_SERVICE_CREDENTIALS,
        }),
        CoreAuditModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: CoreProblemJsonFilter },
        // What `AuditModule.forRoot` registers, with a sink that needs SYSTEM_PRISMA_CLIENT.
        { provide: AuditSink, useFactory: (p: PrismaClient) => new CoreAuditSink(p), inject: [SYSTEM_PRISMA_CLIENT] },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
        { provide: 'oe:core:revocation-hook', useFactory: (s: OAuthService) => (oauth = s), inject: [OAuthService] },
      ],
    };
  }
}
