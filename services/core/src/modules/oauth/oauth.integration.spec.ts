import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller, Get, Global, type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuthModule, RequirePermission, ServiceTokenClient } from '@oe/ts-common/auth';
import { ProblemJsonFilter } from '@oe/ts-common/http';
import { NatsPublisher } from '@oe/ts-common/nats';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { PrismaClient } from '@prisma/client';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PRISMA_CLIENT, PrismaModule } from '../../prisma/prisma.module.js';
import { ApiClientsModule } from '../api-clients/api-clients.module.js';
import { JwtSigner } from '../auth/auth.module.js';
import { SYSTEM_DB_ROLE } from '../tenants/system-prisma.module.js';
import { startTestDatabase } from '../users/testing/harness.js';
import { OAuthModule, OAuthService, RevocationAwareVerifier } from './oauth.module.js';

jest.setTimeout(180_000);

const ISSUER = 'open-emarsys/core';
const SERVICE_SECRET = randomBytes(32).toString('base64url');

/** Stand-ins for public API routes guarded by a scope. */
@Controller('api/v3/probe')
class ProbeController {
  @Get('view')
  @RequirePermission('contacts:view')
  view() {
    return { ok: true };
  }

  @Get('edit')
  @RequirePermission('contacts:edit')
  edit() {
    return { ok: true };
  }
}

const published: unknown[][] = [];
@Global()
@Module({
  providers: [{ provide: NatsPublisher, useValue: { publish: async (...args: unknown[]) => void published.push(args) } }],
  exports: [NatsPublisher],
})
class FakeNatsModule {}

describe('API clients and OAuth client credentials', () => {
  let container: StartedPostgreSqlContainer;
  let core: PrismaClient;
  let su: PrismaClient;
  let app: INestApplication;
  let base: string;
  let tmp: string;
  let signer: JwtSigner;
  let tenantId: string;
  let adminToken: string;
  const output: string[] = [];

  const call = async (url: string, init: RequestInit & { token?: string; json?: unknown; form?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    let body: string | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    if (init.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    }
    const res = await fetch(base + url, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : undefined };
  };
  const token = (form: Record<string, string>, headers?: Record<string, string>) =>
    call('/api/v3/oauth/token', { form, headers });
  const createClient = (scopes: string[]) =>
    call('/admin/v1/api-clients', { token: adminToken, json: { name: 'crm sync', scopes } });

  beforeAll(async () => {
    // Everything the process prints, to prove secrets never reach the logs.
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      jest.spyOn(stream, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: never[]) => {
        output.push(String(chunk));
        return write(chunk, ...rest);
      }) as typeof stream.write);
    }

    const db = await startTestDatabase();
    container = db.container;
    core = db.prisma;
    su = new PrismaClient({ datasourceUrl: `${container.getConnectionUri()}?schema=identity` });
    tenantId = (await su.tenant.create({ data: { name: 'acme', timezone: 'UTC' } })).id;

    tmp = mkdtempSync(path.join(tmpdir(), 'oe-oauth-'));
    const credentials = path.join(tmp, 'service-credentials.json');
    writeFileSync(credentials, JSON.stringify({ segments: { secret: SERVICE_SECRET, scopes: ['contacts:view'] } }));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    signer = new JwtSigner([{ kid: '2026-09', privateKey }], ISSUER);

    let oauth: OAuthService | undefined;
    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthModule.forRoot({ verifier: new RevocationAwareVerifier(signer.verifier(), (id) => oauth!.isRevoked(id)) }),
        PrismaModule,
        FakeNatsModule,
        ApiClientsModule,
        OAuthModule.forRoot({
          signer,
          systemRole: SYSTEM_DB_ROLE,
          serviceCredentialsFile: credentials,
          databaseUrl: `postgresql://core:core@${container.getHost()}:${container.getPort()}/${container.getDatabase()}?schema=identity`,
        }),
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: ProblemJsonFilter }],
    })
      .overrideProvider(PRISMA_CLIENT)
      .useValue(withTenantScope(core))
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    oauth = app.get(OAuthService);

    adminToken = await signer.sign({ sub: 'admin-1', typ: 'user', tenant_id: tenantId, perms: ['identity:admin'] }, 900);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    await core?.$disconnect();
    await su?.$disconnect();
    await container?.stop();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('issues a contacts:view token that reaches a contacts:view route and gets 403 on contacts:edit', async () => {
    const created = await createClient(['contacts:view']);
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const { client_id, client_secret } = created.body;
    expect(Buffer.from(client_secret, 'base64url')).toHaveLength(32);

    const res = await token({ grant_type: 'client_credentials', client_id, client_secret });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'contacts:view' });
    const claims = await signer.verifier().verify(res.body.access_token);
    expect(claims).toMatchObject({ sub: client_id, typ: 'client', tenant_id: tenantId, scopes: ['contacts:view'] });
    expect(claims.exp - claims.iat).toBe(3600);

    expect((await call('/api/v3/probe/view', { token: res.body.access_token })).status).toBe(200);
    expect((await call('/api/v3/probe/edit', { token: res.body.access_token })).status).toBe(403);
    // A client token is not an admin token.
    expect((await call('/admin/v1/api-clients', { token: res.body.access_token })).status).toBe(403);
  });

  it('accepts HTTP Basic credentials and follows RFC 6749 errors', async () => {
    const { client_id, client_secret } = (await createClient(['contacts:view', 'contacts:edit'])).body;
    const basic = `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString('base64')}`;

    const narrowed = await token({ grant_type: 'client_credentials', scope: 'contacts:edit' }, { Authorization: basic });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toBe('contacts:edit');

    expect((await token({ grant_type: 'password' }, { Authorization: basic })).body).toMatchObject({ error: 'unsupported_grant_type' });
    expect((await token({ grant_type: 'client_credentials', scope: 'email:admin' }, { Authorization: basic })).body).toMatchObject({
      error: 'invalid_scope',
    });
    const wrong = await token({ grant_type: 'client_credentials', client_id, client_secret: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'invalid_client', error_description: expect.any(String) });
    expect((await token({ grant_type: 'client_credentials', client_id: 'oec_unknown', client_secret: 'x' })).status).toBe(401);
    expect((await call('/api/v3/oauth/token', { json: { grant_type: 'client_credentials', client_id, client_secret } })).body).toMatchObject({
      error: 'invalid_request',
    });
  });

  it('rate limits after 10 failed attempts per client_id per minute', async () => {
    const { client_id, client_secret } = (await createClient(['contacts:view'])).body;
    for (let i = 0; i < 10; i++) {
      expect((await token({ grant_type: 'client_credentials', client_id, client_secret: `bad-${i}` })).status).toBe(401);
    }
    const blocked = await token({ grant_type: 'client_credentials', client_id, client_secret });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('after revocation, /oauth/token says invalid_client and earlier tokens are rejected', async () => {
    const created = (await createClient(['contacts:view'])).body;
    const { client_id, client_secret } = created;
    const before = (await token({ grant_type: 'client_credentials', client_id, client_secret })).body.access_token;
    expect((await call('/api/v3/probe/view', { token: before })).status).toBe(200);

    const revoked = await call(`/admin/v1/api-clients/${created.id}/revoke`, { method: 'POST', token: adminToken });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: 'revoked', revoked_at: expect.any(String) });
    expect(published).toContainEqual([
      'system.api_client.revoked',
      tenantId,
      null,
      { client_id, revoked_at: revoked.body.revoked_at },
    ]);

    expect((await token({ grant_type: 'client_credentials', client_id, client_secret })).body).toMatchObject({ error: 'invalid_client' });
    // Core's own guard (RevocationAwareVerifier over the database).
    expect((await call('/api/v3/probe/view', { token: before })).status).toBe(401);

    // A verifier outside core: service token → /internal/v1/revocations.
    const service = new ServiceTokenClient({ coreUrl: base, clientId: 'segments', clientSecret: SERVICE_SECRET });
    const serviceClaims = await signer.verifier().verify(await service.getToken());
    expect(serviceClaims).toMatchObject({ typ: 'service', sub: 'segments', tenant_id: null });
    expect(serviceClaims.exp - serviceClaims.iat).toBe(900);
    const remote = new RevocationAwareVerifier(signer.verifier(), async (id) => {
      const list = await call('/internal/v1/revocations', { token: await service.getToken() });
      expect(list.body.max_token_ttl_seconds).toBe(3600);
      return list.body.items.some((r: { client_id: string }) => r.client_id === id);
    });
    await expect(remote.verify(before)).rejects.toThrow('revoked');

    expect((await call('/internal/v1/revocations', { token: adminToken })).status).toBe(403);
    expect((await call('/internal/v1/service-token', { json: { client_id: 'segments', client_secret: 'wrong' } })).status).toBe(401);
  });

  it('never returns or logs the secret after creation', async () => {
    const created = (await createClient(['contacts:view'])).body;
    const { client_id, client_secret } = created;
    await token({ grant_type: 'client_credentials', client_id, client_secret });
    await token({ grant_type: 'client_credentials', client_id, client_secret: `${client_secret}x` });

    const later = [
      await call('/admin/v1/api-clients?limit=200', { token: adminToken }),
      await call(`/admin/v1/api-clients/${created.id}/revoke`, { method: 'POST', token: adminToken }),
      await token({ grant_type: 'client_credentials', client_id, client_secret }),
    ];
    expect(later[0].body.items.map((c: { client_id: string }) => c.client_id)).toContain(client_id);
    for (const res of later) expect(res.text).not.toContain(client_secret);
    expect(JSON.stringify(published)).not.toContain(client_secret);
    expect(output.join('')).not.toContain(client_secret);

    const row = await su.apiClient.findUniqueOrThrow({ where: { clientId: client_id } });
    expect(row.secretHash).toMatch(/^\$argon2id\$/);
    expect(row.secretHash).not.toContain(client_secret);
  });
});
