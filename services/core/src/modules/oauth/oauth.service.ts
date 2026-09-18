import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { withSystemScope } from '@oe/ts-common/prisma-tenant';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ARGON2_OPTIONS, type JwtSigner } from '../auth/auth.module.js';

export const OAUTH_OPTIONS = Symbol('oe:core:oauth-options');
export const OAUTH_PRISMA = Symbol('oe:core:oauth-prisma');

export interface OAuthOptions {
  signer: JwtSigner;
  /** BYPASSRLS role for lookups by `client_id`, which happen before the tenant is known. */
  systemRole: string;
  /**
   * `CORE_SERVICE_CREDENTIALS`: JSON file `{ "<service>": { "secret": "...", "scopes": [...] } }`.
   * Mount it as a secret; each service gets its own entry and uses `ServiceTokenClient`.
   */
  serviceCredentialsFile: string;
  /** Overrides `DATABASE_URL`. */
  databaseUrl?: string;
  now?: () => Date;
}

/**
 * Client tokens live 1 h, so a revoked client's tokens stay cryptographically valid for at most
 * that long (plus the verifier's 60 s clock tolerance). Verifiers must check `/internal/v1/revocations`
 * (or `system.api_client.revoked`) during that window; after it the tokens are expired anyway.
 */
export const CLIENT_TOKEN_TTL = 3600;
export const SERVICE_TOKEN_TTL = 900;
const REVOCATION_WINDOW_MS = (CLIENT_TOKEN_TTL + 60) * 1000;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;

const permission = z.string().regex(/^[a-z_]+:(view|edit|launch|admin)$/);
const serviceCredentials = z.record(
  z.string().min(1),
  z.object({ secret: z.string().min(32), scopes: z.array(permission).default([]) })
);

/** RFC 6749 §5.2 error; the controller writes it as `{error, error_description}`. */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
    readonly retryAfter?: number
  ) {
    super(description);
  }
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const invalidClient = () => new OAuthError(401, 'invalid_client', 'Client authentication failed');

@Injectable()
export class OAuthService {
  private readonly now: () => Date;
  private readonly services: z.infer<typeof serviceCredentials>;
  // ponytail: per-process counters; move to Redis/Postgres when core runs more than one replica.
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  // Verified against for unknown client ids, so they take as long as wrong secrets.
  private readonly dummyHash = hash(randomUUID(), ARGON2_OPTIONS);

  constructor(
    @Inject(OAUTH_OPTIONS) private readonly options: OAuthOptions,
    @Inject(OAUTH_PRISMA) private readonly prisma: PrismaClient
  ) {
    this.now = options.now ?? (() => new Date());
    this.services = serviceCredentials.parse(JSON.parse(readFileSync(options.serviceCredentialsFile, 'utf8')));
  }

  /** `grant_type=client_credentials` (C2). `scope` narrows the client's scopes; omitted grants all. */
  async clientToken(clientId: string, secret: string, scope?: string): Promise<TokenResponse> {
    const now = this.now().getTime();
    const f = this.failures.get(clientId);
    if (f && f.resetAt > now && f.count >= MAX_FAILURES) {
      throw new OAuthError(429, 'invalid_client', 'Too many failed attempts', Math.ceil((f.resetAt - now) / 1000));
    }
    const row = await withSystemScope(() =>
      this.prisma.apiClient.findUnique({ where: { clientId }, include: { tenant: { select: { status: true } } } })
    );
    const ok = row ? await verify(row.secretHash, secret) : await verify(await this.dummyHash, secret).then(() => false);
    if (!ok) {
      this.recordFailure(clientId, now);
      throw invalidClient();
    }
    if (row!.revokedAt || row!.tenant.status === 'suspended') throw invalidClient();

    let scopes = row!.scopes;
    if (scope !== undefined) {
      const requested = [...new Set(scope.split(' ').filter(Boolean))];
      const extra = requested.filter((s) => !scopes.includes(s));
      if (extra.length) throw new OAuthError(400, 'invalid_scope', `Scope not granted: ${extra.join(' ')}`);
      if (requested.length) scopes = requested;
    }
    this.failures.delete(clientId);
    await withSystemScope(() => this.prisma.apiClient.update({ where: { id: row!.id }, data: { lastUsedAt: new Date(now) } }));
    const access_token = await this.options.signer.sign(
      { sub: clientId, typ: 'client', tenant_id: row!.tenantId, scopes },
      CLIENT_TOKEN_TTL
    );
    return { access_token, token_type: 'Bearer', expires_in: CLIENT_TOKEN_TTL, scope: scopes.join(' ') };
  }

  /** `typ=service` token for C4 calls, from `CORE_SERVICE_CREDENTIALS`. Returns undefined on bad credentials. */
  async serviceToken(service: string, secret: string): Promise<TokenResponse | undefined> {
    const entry = Object.hasOwn(this.services, service) ? this.services[service] : undefined;
    // Compare digests: equal length, so timingSafeEqual never throws or leaks the length.
    const ok = timingSafeEqual(sha256(entry?.secret ?? randomUUID()), sha256(secret));
    if (!entry || !ok) return undefined;
    const access_token = await this.options.signer.sign(
      { sub: service, typ: 'service', tenant_id: null, scopes: entry.scopes },
      SERVICE_TOKEN_TTL
    );
    return { access_token, token_type: 'Bearer', expires_in: SERVICE_TOKEN_TTL };
  }

  /** Clients revoked recently enough that tokens issued to them may still be unexpired. */
  async revocations(): Promise<{ max_token_ttl_seconds: number; items: { client_id: string; revoked_at: string }[] }> {
    const since = new Date(this.now().getTime() - REVOCATION_WINDOW_MS);
    const rows = await withSystemScope(() =>
      this.prisma.apiClient.findMany({
        where: { revokedAt: { gt: since } },
        select: { clientId: true, revokedAt: true },
        orderBy: { revokedAt: 'asc' },
      })
    );
    return {
      max_token_ttl_seconds: CLIENT_TOKEN_TTL,
      items: rows.map((r) => ({ client_id: r.clientId, revoked_at: r.revokedAt!.toISOString() })),
    };
  }

  /** For core's own verifier (`RevocationAwareVerifier`): revoked or deleted clients. */
  async isRevoked(clientId: string): Promise<boolean> {
    const row = await withSystemScope(() =>
      this.prisma.apiClient.findUnique({ where: { clientId }, select: { revokedAt: true } })
    );
    return !row || row.revokedAt !== null;
  }

  private recordFailure(clientId: string, now: number): void {
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    }
    const f = this.failures.get(clientId);
    if (!f || f.resetAt <= now) this.failures.set(clientId, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    else f.count++;
  }
}
