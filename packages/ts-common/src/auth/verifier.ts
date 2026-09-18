import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JSONWebKeySet,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';

const permission = z.string().regex(/^[a-z_]+:(view|edit|launch|admin)$/);

/** `JwtClaims` from `contracts/openapi/admin-v1/identity.yaml`. */
const jwtClaims = z
  .object({
    sub: z.string().min(1),
    typ: z.enum(['user', 'client', 'service']),
    tenant_id: z.string().uuid().nullable(),
    perms: z.array(permission).optional(),
    scopes: z.array(permission).optional(),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .refine((c) =>
    c.typ === 'user'
      ? c.perms !== undefined && c.scopes === undefined
      : c.scopes !== undefined && c.perms === undefined
  );

export type JwtClaims = z.infer<typeof jwtClaims>;

/** Authenticated caller, as attached to the request by `JwtAuthGuard`. */
export type Principal = JwtClaims;

/** Permissions a principal holds: `perms` for users, `scopes` for clients and services. */
export function grantsOf(p: Principal): string[] {
  return (p.typ === 'user' ? p.perms : p.scopes) ?? [];
}

/** Verifies an RS256 bearer token and returns its validated claims; throws on any failure. */
export class TokenVerifier {
  constructor(
    protected keys: JWTVerifyGetKey,
    private readonly issuer: string
  ) {}

  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.keys, {
      algorithms: ['RS256'],
      issuer: this.issuer,
      typ: 'JWT',
      clockTolerance: 60,
      requiredClaims: ['iat', 'exp'],
    });
    return jwtClaims.parse(payload);
  }
}

export interface RemoteJwksOptions {
  jwksUrl: string;
  issuer: string;
  /** Minimum time between JWKS refetches triggered by an unknown `kid`. Default 60 s. */
  cooldownMs?: number;
  /** Maximum age of the cached JWKS. Default 10 min. */
  cacheMaxAgeMs?: number;
}

/** Verifier backed by core's `/.well-known/jwks.json`; refetches on unknown `kid` (rotation). */
export class RemoteJwksVerifier extends TokenVerifier {
  constructor(o: RemoteJwksOptions) {
    super(
      createRemoteJWKSet(new URL(o.jwksUrl), {
        cooldownDuration: o.cooldownMs ?? 60_000,
        cacheMaxAge: o.cacheMaxAgeMs ?? 600_000,
      }),
      o.issuer
    );
  }
}

/** For core: verifies against the public keys it already holds in memory, without HTTP. */
export class LocalKeyVerifier extends TokenVerifier {
  constructor(jwks: JSONWebKeySet, issuer: string) {
    super(createLocalJWKSet(jwks), issuer);
  }

  /** Swap the key set after a rotation. */
  setKeys(jwks: JSONWebKeySet): void {
    this.keys = createLocalJWKSet(jwks);
  }
}
