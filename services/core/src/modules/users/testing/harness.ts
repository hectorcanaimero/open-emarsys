import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthModule, LocalKeyVerifier } from '@oe/ts-common/auth';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { exportJWK, generateKeyPair, type JSONWebKeySet, type KeyLike, SignJWT } from 'jose';
import { PRISMA_CLIENT, PrismaModule } from '../../../prisma/prisma.module.js';

const coreDir = path.resolve(__dirname, '../../../..');
const initSql = path.resolve(coreDir, '../../deploy/postgres/init/00-roles.sql');
// 00-roles.sql `\getenv`s one password per service role; the postgres image errors if any
// referenced env var is unset, even though only `core` is used in tests.
const SERVICE_ROLES = [
  'CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER',
  'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL',
];

export const TEST_ISSUER = 'test-issuer';

export interface TestKeys {
  privateKey: KeyLike;
  kid: string;
  jwks: JSONWebKeySet;
}

/** One RS256 keypair for every test in a suite (key generation is slow; reuse it). */
export async function generateTestKeys(): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const kid = 'test-key';
  const jwk = await exportJWK(publicKey);
  return { privateKey, kid, jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] } };
}

/** Signs a `JwtClaims`-shaped token (see `@oe/ts-common/auth`) for the given principal. */
export async function signPrincipal(
  keys: TestKeys,
  claims: {
    sub: string;
    typ?: 'user' | 'client' | 'service';
    tenant_id: string | null;
    perms?: string[];
    scopes?: string[];
  }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: claims.typ ?? 'user', tenant_id: claims.tenant_id, perms: claims.perms, scopes: claims.scopes })
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .setIssuer(TEST_ISSUER)
    .sign(keys.privateKey);
}

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  prisma: PrismaClient;
}

/** Starts Postgres, runs `prisma migrate deploy`, and hands back a plain (unscoped) client. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withEnvironment(Object.fromEntries(SERVICE_ROLES.map((r) => [`OE_PG_${r}_PASSWORD`, r.toLowerCase()])))
    .withCopyFilesToContainer([{ source: initSql, target: '/docker-entrypoint-initdb.d/00-roles.sql' }])
    .start();
  const url = `postgresql://core:core@${container.getHost()}:${container.getPort()}/${container.getDatabase()}?schema=identity`;
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: coreDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
  return { container, prisma: new PrismaClient({ datasourceUrl: url }) };
}

/** Boots a real Nest HTTP app (auth guard + tenant-scoped Prisma + the given feature modules). */
export async function startTestApp(opts: {
  imports: (Type | DynamicModule)[];
  prisma: PrismaClient;
  keys: TestKeys;
  /** Extra `overrideProvider(token).useValue(value)` pairs, e.g. to fake `MAIL_TRANSPORT`. */
  overrides?: [token: unknown, value: unknown][];
}): Promise<{ app: INestApplication; baseUrl: string }> {
  let builder = Test.createTestingModule({
    imports: [
      AuthModule.forRoot({ verifier: new LocalKeyVerifier(opts.keys.jwks, TEST_ISSUER) }),
      PrismaModule,
      ...opts.imports,
    ],
  })
    .overrideProvider(PRISMA_CLIENT)
    .useValue(withTenantScope(opts.prisma));

  for (const [token, value] of opts.overrides ?? []) {
    builder = builder.overrideProvider(token as Type).useValue(value);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  const address = app.getHttpServer().address();
  const port = typeof address === 'string' ? address : address.port;
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}
