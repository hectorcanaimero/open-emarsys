import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './guard.js';
import { RemoteJwksVerifier, type RemoteJwksOptions, TokenVerifier } from './verifier.js';

export * from './guard.js';
export * from './service-token.js';
export * from './verifier.js';

/** Either core's JWKS endpoint, or (in core) a verifier over in-memory keys. */
export type AuthModuleOptions = RemoteJwksOptions | { verifier: TokenVerifier };

@Module({})
export class AuthModule {
  /** Registers `JwtAuthGuard` globally; every route needs a token unless `@Public()`. */
  static forRoot(options: AuthModuleOptions): DynamicModule {
    const verifier = 'verifier' in options ? options.verifier : new RemoteJwksVerifier(options);
    return {
      module: AuthModule,
      global: true,
      providers: [
        { provide: TokenVerifier, useValue: verifier },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
      exports: [TokenVerifier],
    };
  }
}
