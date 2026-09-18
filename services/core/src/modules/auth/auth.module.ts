import { type DynamicModule, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { PrismaClient } from '@prisma/client';
import { AuthController } from './auth.controller.js';
import { AUTH_OPTIONS, AUTH_PRISMA, type AuthOptions, AuthService } from './auth.service.js';

export { AccountLockedException, ARGON2_OPTIONS, type AuthOptions, AuthService } from './auth.service.js';
export { JwtSigner } from './jwt-signer.js';

/**
 * Login, MFA, sessions and JWKS (D7). Wiring (F0.6.T8):
 *
 *   const signer = JwtSigner.fromDir(CORE_JWT_KEYS_DIR, CORE_JWT_ISSUER);
 *   AuthModule.forRoot({ verifier: signer.verifier() }),        // @oe/ts-common/auth
 *   IdentityAuthModule.forRoot({ signer, encryptionKey: CORE_ENCRYPTION_KEY, systemRole }),
 */
@Module({})
export class IdentityAuthModule implements OnModuleDestroy {
  constructor(@Inject(AUTH_PRISMA) private readonly prisma: PrismaClient) {}

  static forRoot(options: AuthOptions): DynamicModule {
    return {
      module: IdentityAuthModule,
      controllers: [AuthController],
      providers: [
        { provide: AUTH_OPTIONS, useValue: options },
        {
          provide: AUTH_PRISMA,
          useFactory: () =>
            withTenantScope(new PrismaClient(options.databaseUrl ? { datasourceUrl: options.databaseUrl } : undefined), {
              systemRole: options.systemRole,
            }),
        },
        AuthService,
      ],
      exports: [AuthService],
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
