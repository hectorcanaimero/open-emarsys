import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LocalKeyVerifier } from '@oe/ts-common/auth';
import { createLocalJWKSet, type JSONWebKeySet, type JWK, type JWTPayload, jwtVerify, SignJWT } from 'jose';

/**
 * RS256 keys from `CORE_JWT_KEYS_DIR` (D7): one PKCS#8/PKCS#1 PEM private key per file,
 * `kid` = file name without `.pem`. Every key is published in the JWKS; the key whose
 * `kid` sorts last signs. Rotation: add the new key (e.g. `2026-10.pem`) next to the old
 * one, restart, and delete the old file once its tokens have expired.
 */
export class JwtSigner {
  readonly jwks: JSONWebKeySet;
  private readonly signingKid: string;
  private readonly signingKey: KeyObject;

  constructor(
    keys: Array<{ kid: string; privateKey: KeyObject }>,
    readonly issuer: string
  ) {
    if (!keys.length) throw new Error('JwtSigner: no signing keys');
    const sorted = [...keys].sort((a, b) => a.kid.localeCompare(b.kid));
    for (const k of sorted) {
      if (k.privateKey.asymmetricKeyType !== 'rsa') throw new Error(`JwtSigner: key "${k.kid}" is not RSA`);
    }
    this.jwks = {
      keys: sorted.map((k) => ({
        ...(createPublicKey(k.privateKey).export({ format: 'jwk' }) as JWK),
        kid: k.kid,
        alg: 'RS256',
        use: 'sig',
      })),
    };
    this.signingKid = sorted[sorted.length - 1].kid;
    this.signingKey = sorted[sorted.length - 1].privateKey;
  }

  static fromDir(dir: string, issuer: string): JwtSigner {
    const files = readdirSync(dir).filter((f) => f.endsWith('.pem'));
    return new JwtSigner(
      files.map((f) => ({ kid: f.slice(0, -4), privateKey: createPrivateKey(readFileSync(path.join(dir, f))) })),
      issuer
    );
  }

  /** Signs `claims` (must include `sub` and `typ`) valid for `ttlSeconds`. */
  sign(claims: JWTPayload & { sub: string; typ: string }, ttlSeconds: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: this.signingKid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .sign(this.signingKey);
  }

  /** Verifies a token signed here and requires its `typ` claim; throws otherwise. */
  async verify(token: string, typ: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, createLocalJWKSet(this.jwks), {
      algorithms: ['RS256'],
      issuer: this.issuer,
      requiredClaims: ['sub', 'exp'],
    });
    if (payload.typ !== typ) throw new Error(`expected typ=${typ}`);
    return payload;
  }

  /** `TokenVerifier` over these keys, for `AuthModule.forRoot({ verifier })` in core. */
  verifier(): LocalKeyVerifier {
    return new LocalKeyVerifier(this.jwks, this.issuer);
  }
}
