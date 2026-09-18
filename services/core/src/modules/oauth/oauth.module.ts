import { type DynamicModule, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { PrismaClient } from '@prisma/client';
import { OAuthController } from './oauth.controller.js';
import { OAUTH_OPTIONS, OAUTH_PRISMA, type OAuthOptions, OAuthService } from './oauth.service.js';

export { CLIENT_TOKEN_TTL, type OAuthOptions, OAuthService, SERVICE_TOKEN_TTL } from './oauth.service.js';
export { RevocationAwareVerifier } from './revocation-verifier.js';

/**
 * `POST /api/v3/oauth/token`, `POST /internal/v1/service-token`, `GET /internal/v1/revocations`
 * (FR-4, NFR-9). Wiring (F0.6.T8), so core itself rejects revoked clients' tokens:
 *
 *   let oauth: OAuthService;
 *   AuthModule.forRoot({ verifier: new RevocationAwareVerifier(signer.verifier(), (id) => oauth.isRevoked(id)) }),
 *   OAuthModule.forRoot({ signer, systemRole, serviceCredentialsFile: CORE_SERVICE_CREDENTIALS }),
 *   // after NestFactory.create: oauth = app.get(OAuthService);
 */
@Module({})
export class OAuthModule implements OnModuleDestroy {
  constructor(@Inject(OAUTH_PRISMA) private readonly prisma: PrismaClient) {}

  static forRoot(options: OAuthOptions): DynamicModule {
    return {
      module: OAuthModule,
      controllers: [OAuthController],
      providers: [
        { provide: OAUTH_OPTIONS, useValue: options },
        {
          provide: OAUTH_PRISMA,
          useFactory: () =>
            withTenantScope(new PrismaClient(options.databaseUrl ? { datasourceUrl: options.databaseUrl } : undefined), {
              systemRole: options.systemRole,
            }),
        },
        OAuthService,
      ],
      exports: [OAuthService],
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
