import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthModule, LocalKeyVerifier } from '@oe/ts-common/auth';
import { ProblemJsonFilter } from '@oe/ts-common/http';
import { NatsModule } from '@oe/ts-common/nats';
import { withSystemScope } from '@oe/ts-common/prisma-tenant';
import type { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { exportJWK, generateKeyPair, type JWK, type KeyLike, SignJWT } from 'jose';
import { AckPolicy, connect, type NatsConnection, RetentionPolicy, StorageType } from 'nats';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { PERMISSION_ACTIONS, PERMISSION_MODULES } from '../identity-shared/permissions.js';
import { SYSTEM_PRISMA_CLIENT } from './system-prisma.module.js';
import { TenantsModule } from './tenants.module.js';
import { TenantsService } from './tenants.service.js';

jest.setTimeout(180_000);

const ISSUER = 'https://core.test';
const coreDir = path.resolve(__dirname, '../../..');
const initSql = path.resolve(coreDir, '../../deploy/postgres/init/00-roles.sql');
const ROLES = [
  'CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER',
  'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL',
];
const MARKETING_MODULE_COUNT = PERMISSION_MODULES.length - 2; // all but `platform` and `identity`

interface Key {
  kid: string;
  privateKey: KeyLike;
  jwk: JWK;
}

async function makeKey(kid: string): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
}

describe('tenants (operator console, FR-1)', () => {
  let pg: StartedPostgreSqlContainer;
  let nats: StartedTestContainer;
  let natsConn: NatsConnection;
  let app: INestApplication;
  let baseUrl: string;
  let tenantsService: TenantsService;
  let systemPrisma: PrismaClient;
  let key: Key;

  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key.privateKey);

  const operatorToken = () =>
    sign({ sub: 'operator-1', typ: 'user', tenant_id: null, perms: ['tenants:view', 'tenants:admin'] });

  const tenantUserToken = (tenantId: string) =>
    sign({ sub: 'user-1', typ: 'user', tenant_id: tenantId, perms: ['tenants:view', 'tenants:admin'] });

  const request = async (
    method: string,
    urlPath: string,
    opts: { token?: string; body?: unknown } = {}
  ): Promise<{ status: number; contentType: string | null; body: unknown }> => {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: text ? JSON.parse(text) : undefined,
    };
  };

  const createTenant = async (overrides: Record<string, unknown> = {}) =>
    request('POST', '/admin/v1/tenants', {
      token: await operatorToken(),
      body: {
        name: 'Acme',
        timezone: 'America/Mexico_City',
        default_locale: 'es',
        ...overrides,
      },
    });

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:17-alpine')
      .withEnvironment(Object.fromEntries(ROLES.map((r) => [`OE_PG_${r}_PASSWORD`, r.toLowerCase()])))
      .withCopyFilesToContainer([{ source: initSql, target: '/docker-entrypoint-initdb.d/00-roles.sql' }])
      .start();
    const dbUrl = `postgresql://core:core@${pg.getHost()}:${pg.getPort()}/${pg.getDatabase()}?schema=identity`;
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: coreDir,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'inherit',
    });
    process.env.DATABASE_URL = dbUrl;

    nats = await new GenericContainer('nats:2.11-alpine')
      .withCommand(['-js'])
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
      .start();
    const natsServers = `${nats.getHost()}:${nats.getMappedPort(4222)}`;
    natsConn = await connect({ servers: natsServers });
    const jsm = await natsConn.jetstreamManager();
    await jsm.streams.add({
      name: 'TEST_STREAM',
      subjects: ['oe.system.>'],
      retention: RetentionPolicy.Limits,
      storage: StorageType.Memory,
    });

    key = await makeKey('k1');

    const moduleRef = await Test.createTestingModule({
      imports: [
        NatsModule.forRoot({ servers: natsServers, source: 'core-test' }),
        AuthModule.forRoot({ verifier: new LocalKeyVerifier({ keys: [key.jwk] }, ISSUER) }),
        TenantsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemJsonFilter());
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    tenantsService = moduleRef.get(TenantsService);
    systemPrisma = moduleRef.get(SYSTEM_PRISMA_CLIENT, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
    await natsConn?.close();
    await nats?.stop();
    await pg?.stop();
  });

  it('creates a tenant with its default roles and publishes system.tenant.created', async () => {
    const created = await createTenant();
    expect(created.status).toBe(201);
    const tenant = created.body as { id: string; status: string; created_at: string };
    expect(tenant).toMatchObject({
      name: 'Acme',
      timezone: 'America/Mexico_City',
      default_locale: 'es',
      status: 'active',
    });
    expect(tenant.id).toMatch(/^[0-9a-f-]{36}$/);

    const roles = await withSystemScope(() =>
      systemPrisma.role.findMany({
        where: { tenantId: tenant.id },
        include: { permissions: true },
        orderBy: { name: 'asc' },
      })
    );
    const byName = Object.fromEntries(roles.map((r) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual(['Admin', 'Marketer', 'Viewer']);
    expect(byName.Admin!.isDefault).toBe(true);
    expect(byName.Admin!.permissions).toHaveLength(PERMISSION_MODULES.length * PERMISSION_ACTIONS.length);
    expect(byName.Marketer!.permissions).toHaveLength(MARKETING_MODULE_COUNT * 3);
    expect(byName.Viewer!.permissions).toHaveLength(MARKETING_MODULE_COUNT);
    expect(byName.Viewer!.permissions.every((p) => p.action === 'view')).toBe(true);

    const js = natsConn.jetstream();
    const jsm = await natsConn.jetstreamManager();
    await jsm.consumers.add('TEST_STREAM', {
      durable_name: `assert-${tenant.id}`,
      filter_subject: `oe.system.tenant.created.${tenant.id}`,
      ack_policy: AckPolicy.Explicit,
    });
    const consumer = await js.consumers.get('TEST_STREAM', `assert-${tenant.id}`);
    const msgs = await consumer.fetch({ max_messages: 1, expires: 5_000 });
    let received: { type: string; tenant_id: string; data: { id: string } } | undefined;
    for await (const msg of msgs) {
      received = JSON.parse(Buffer.from(msg.data).toString('utf8'));
      msg.ack();
    }
    expect(received).toMatchObject({ type: 'system.tenant.created', tenant_id: tenant.id, data: { id: tenant.id } });
  });

  it('creates the first Admin in the same transaction when `admin` is given', async () => {
    const res = await createTenant({
      name: 'With Admin',
      admin: { email: 'boss@with-admin.test', password: 'a-long-unique-passphrase' },
    });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    const users = await withSystemScope(() =>
      systemPrisma.user.findMany({ where: { tenantId: id }, include: { roles: true } })
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: 'boss@with-admin.test', status: 'active' });
    expect(users[0]!.passwordHash).toMatch(/^\$argon2/);
    const adminRole = await withSystemScope(() =>
      systemPrisma.role.findFirstOrThrow({ where: { tenantId: id, name: 'Admin' } })
    );
    expect(users[0]!.roles.map((r) => r.roleId)).toEqual([adminRole.id]);
  });

  it('rejects a weak or malformed `admin` with 400 and creates no tenant', async () => {
    for (const admin of [
      { email: 'x@weak.test', password: 'short' },
      { email: 'x@weak.test', password: 'password1234' },
      { email: 'not-an-email', password: 'a-long-unique-passphrase' },
    ]) {
      const res = await createTenant({ name: 'Weak Admin Tenant', admin });
      expect(res.status).toBe(400);
    }
    const count = await withSystemScope(() => systemPrisma.tenant.count({ where: { name: 'Weak Admin Tenant' } }));
    expect(count).toBe(0);
  });

  it('rejects an invalid IANA time zone with 400 problem+json', async () => {
    const res = await createTenant({ timezone: 'Not/AZone' });
    expect(res.status).toBe(400);
    expect(res.contentType).toContain('application/problem+json');
    const body = res.body as { status: number; errors: Array<{ pointer: string }> };
    expect(body.status).toBe(400);
    expect(body.errors.some((e) => e.pointer === '/timezone')).toBe(true);
  });

  it('rejects a tenant-scoped principal on operator-only routes with 403', async () => {
    const res = await request('GET', '/admin/v1/tenants', { token: await tenantUserToken(crypto.randomUUID()) });
    expect(res.status).toBe(403);
  });

  it('rejects requests without a token with 401', async () => {
    const res = await request('GET', '/admin/v1/tenants');
    expect(res.status).toBe(401);
  });

  it('returns 404 for a tenant that does not exist', async () => {
    const res = await request('GET', `/admin/v1/tenants/${crypto.randomUUID()}`, { token: await operatorToken() });
    expect(res.status).toBe(404);
  });

  it('updates a tenant and lets a suspended tenant fail assertActive (login/API-token gate)', async () => {
    const created = await createTenant({ name: 'Suspend Me' });
    const id = (created.body as { id: string }).id;

    await tenantsService.assertActive(id); // active: does not throw

    const patched = await request('PATCH', `/admin/v1/tenants/${id}`, {
      token: await operatorToken(),
      body: { status: 'suspended' },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { status: string }).status).toBe('suspended');

    await expect(tenantsService.assertActive(id)).rejects.toMatchObject({ status: 403 });
  });

  it('lists tenants for the operator', async () => {
    await createTenant({ name: 'Listed Tenant' });
    const res = await request('GET', '/admin/v1/tenants?limit=200', { token: await operatorToken() });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ name: string }>; next_cursor: string | null };
    expect(body.items.some((t) => t.name === 'Listed Tenant')).toBe(true);
  });
});
