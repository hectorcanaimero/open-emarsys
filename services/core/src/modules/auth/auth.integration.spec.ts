import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { AuthModule, RemoteJwksVerifier } from '@oe/ts-common/auth';
import { ProblemJsonFilter } from '@oe/ts-common/http';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { authenticator } from 'otplib';
import { ARGON2_OPTIONS, IdentityAuthModule, JwtSigner } from './auth.module.js';

jest.setTimeout(180_000);

const coreDir = path.resolve(__dirname, '../../..');
const initSql = path.resolve(coreDir, '../../deploy/postgres/init/00-roles.sql');
const ROLES = ['CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER', 'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL'];
const ISSUER = 'open-emarsys/core';
const PASSWORD = 'correct horse battery staple';

// The BYPASSRLS role auth runs its pre-tenant lookups under (withSystemScope).
describe('auth (login, MFA, sessions, JWKS)', () => {
  let container: StartedPostgreSqlContainer;
  let db: PrismaClient;
  let app: INestApplication;
  let base: string;
  let keysDir: string;
  let clock = Date.now();
  let tenantId: string;

  const post = async (url: string, body: unknown, token?: string, method = 'POST') => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  };
  const login = (email: string, password = PASSWORD) => post('/admin/v1/auth/login', { email, password });

  const createUser = async (email: string, tenant = tenantId) => {
    const role = await db.role.findFirstOrThrow({ where: { tenantId: tenant } });
    return db.user.create({
      data: {
        tenantId: tenant,
        email,
        passwordHash: await hash(PASSWORD, ARGON2_OPTIONS),
        roles: { create: { roleId: role.id, tenantId: tenant } },
      },
    });
  };

  /** Logs in, enrolls and confirms MFA; returns the TOTP secret and recovery codes. */
  const enableMfa = async (email: string) => {
    const { body: tokens } = await login(email);
    const { body: enroll } = await post('/admin/v1/me/mfa/enroll', {}, tokens.access_token);
    expect(enroll.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
    const confirm = await post('/admin/v1/me/mfa/confirm', { code: authenticator.generate(enroll.secret) }, tokens.access_token);
    expect(confirm.status).toBe(200);
    expect(confirm.body.recovery_codes).toHaveLength(10);
    return { secret: enroll.secret as string, recovery: confirm.body.recovery_codes as string[] };
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withEnvironment(Object.fromEntries(ROLES.map((r) => [`OE_PG_${r}_PASSWORD`, r.toLowerCase()])))
      .withCopyFilesToContainer([{ source: initSql, target: '/docker-entrypoint-initdb.d/00-roles.sql' }])
      .start();
    const url = `postgresql://core:core@${container.getHost()}:${container.getPort()}/${container.getDatabase()}?schema=identity`;
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: coreDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'inherit',
    });
    // Seed with the superuser (RLS does not apply).
    db = new PrismaClient({ datasourceUrl: `${container.getConnectionUri()}?schema=identity` });
    for (const [name, status] of [['acme', 'active'], ['frozen', 'suspended']] as const) {
      const t = await db.tenant.create({ data: { name, timezone: 'UTC', status } });
      await db.role.create({
        data: {
          tenantId: t.id,
          name: 'Marketer',
          permissions: {
            create: [
              { tenantId: t.id, module: 'campaigns', action: 'view' },
              { tenantId: t.id, module: 'contacts', action: 'edit' },
            ],
          },
        },
      });
      if (name === 'acme') tenantId = t.id;
    }

    keysDir = mkdtempSync(path.join(tmpdir(), 'oe-jwt-'));
    for (const kid of ['2026-08', '2026-09']) {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      writeFileSync(path.join(keysDir, `${kid}.pem`), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    }
    const signer = JwtSigner.fromDir(keysDir, ISSUER);

    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthModule.forRoot({ verifier: signer.verifier() }),
        IdentityAuthModule.forRoot({
          signer,
          encryptionKey: randomBytes(32).toString('base64'),
          systemRole: 'core_system',
          databaseUrl: url,
          now: () => new Date(clock),
        }),
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemJsonFilter }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    await container?.stop();
    if (keysDir) rmSync(keysDir, { recursive: true, force: true });
  });

  it('logs in and issues an access token the JWKS verifies with @oe/ts-common/auth', async () => {
    const user = await createUser('ana@acme.test');
    const res = await login('ANA@acme.test');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mfa_required: false, token_type: 'Bearer', expires_in: 900 });

    const jwks = await (await fetch(`${base}/.well-known/jwks.json`)).json();
    expect(jwks.keys.map((k: { kid: string }) => k.kid)).toEqual(['2026-08', '2026-09']);
    expect(JSON.stringify(jwks)).not.toMatch(/"d"/);

    const verifier = new RemoteJwksVerifier({ jwksUrl: `${base}/.well-known/jwks.json`, issuer: ISSUER });
    const claims = await verifier.verify(res.body.access_token);
    expect(claims).toMatchObject({ sub: user.id, typ: 'user', tenant_id: tenantId, perms: ['campaigns:view', 'contacts:edit'] });
    expect(claims.exp - claims.iat).toBe(900);

    const me = await post('/admin/v1/me', { locale: 'pt' }, res.body.access_token, 'PATCH');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: user.id, locale: 'pt', mfa_enabled: false });
    expect((await post('/admin/v1/me', { locale: 'fr' }, res.body.access_token, 'PATCH')).status).toBe(400);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    await createUser('bob@acme.test');
    const wrong = await login('bob@acme.test', 'nope');
    const unknown = await login('nobody@acme.test', 'nope');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.detail).toBe(unknown.body.detail);
  });

  it('locks the account on the 5th failure and unlocks it after 15 minutes', async () => {
    await createUser('carl@acme.test');
    for (let i = 1; i <= 4; i++) expect((await login('carl@acme.test', 'nope')).status).toBe(401);
    const fifth = await login('carl@acme.test', 'nope');
    expect(fifth.status).toBe(423);
    expect(fifth.headers.get('retry-after')).toBe('900');

    expect((await login('carl@acme.test')).status).toBe(423);
    clock += 14 * 60_000;
    expect((await login('carl@acme.test')).status).toBe(423);
    clock += 60_000;
    expect((await login('carl@acme.test')).status).toBe(200);
  });

  it('rejects login to a suspended tenant with 403', async () => {
    const frozen = await db.tenant.findFirstOrThrow({ where: { status: 'suspended' } });
    await createUser('dan@frozen.test', frozen.id);
    expect((await login('dan@frozen.test')).status).toBe(403);
  });

  it('requires a TOTP code when MFA is on, and rejects an invalid one', async () => {
    await createUser('eva@acme.test');
    const { secret } = await enableMfa('eva@acme.test');

    const res = await login('eva@acme.test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfa_required: true, mfa_token: expect.any(String) });
    // The MFA token is not an access token.
    expect((await post('/admin/v1/me', { locale: 'en' }, res.body.mfa_token, 'PATCH')).status).toBe(401);

    const valid = authenticator.generate(secret);
    const invalid = String((Number(valid) + 500_000) % 1_000_000).padStart(6, '0');
    expect((await post('/admin/v1/auth/mfa/verify', { mfa_token: res.body.mfa_token, code: invalid })).status).toBe(401);

    const ok = await post('/admin/v1/auth/mfa/verify', { mfa_token: res.body.mfa_token, code: valid });
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toEqual(expect.any(String));

    const off = await post('/admin/v1/me/mfa', { code: authenticator.generate(secret) }, ok.body.access_token, 'DELETE');
    expect(off.status).toBe(204);
    expect((await login('eva@acme.test')).body.mfa_required).toBe(false);
  });

  it('accepts a recovery code only once', async () => {
    await createUser('fay@acme.test');
    const { recovery } = await enableMfa('fay@acme.test');

    const first = await login('fay@acme.test');
    expect((await post('/admin/v1/auth/mfa/verify', { mfa_token: first.body.mfa_token, code: recovery[0] })).status).toBe(200);
    const second = await login('fay@acme.test');
    expect((await post('/admin/v1/auth/mfa/verify', { mfa_token: second.body.mfa_token, code: recovery[0] })).status).toBe(401);
    expect((await post('/admin/v1/auth/mfa/verify', { mfa_token: second.body.mfa_token, code: recovery[1] })).status).toBe(200);
  });

  it('rotates refresh tokens and revokes the family when one is reused', async () => {
    await createUser('gus@acme.test');
    const { body: t1 } = await login('gus@acme.test');

    const r2 = await post('/admin/v1/auth/refresh', { refresh_token: t1.refresh_token });
    expect(r2.status).toBe(200);
    expect(r2.body.refresh_token).not.toBe(t1.refresh_token);

    // Replaying the rotated token kills the session, including the token issued from it.
    expect((await post('/admin/v1/auth/refresh', { refresh_token: t1.refresh_token })).status).toBe(401);
    expect((await post('/admin/v1/auth/refresh', { refresh_token: r2.body.refresh_token })).status).toBe(401);

    // Logout ends a fresh session.
    const { body: t3 } = await login('gus@acme.test');
    expect((await post('/admin/v1/auth/logout', { refresh_token: t3.refresh_token }, t3.access_token)).status).toBe(204);
    expect((await post('/admin/v1/auth/refresh', { refresh_token: t3.refresh_token })).status).toBe(401);
  });
});
