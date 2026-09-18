import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SignJWT } from 'jose';
import { connect } from 'nats';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { AppModule } from '../../src/app.module.js';
import type { CoreConfig } from '../../src/main.js';
import { JwtSigner } from '../../src/modules/auth/auth.module.js';
import { PERMISSION_ACTIONS, PERMISSION_MODULES } from '../../src/modules/identity-shared/permissions.js';
import { OperatorOnlyGuard } from '../../src/modules/tenants/index.js';
import { MAIL_TRANSPORT } from '../../src/modules/users/mailer.js';
import { startTestDatabase } from '../../src/modules/users/testing/harness.js';

// Cross-cutting security suite over the whole AppModule (NFR-8, FR-2, D7). Conventions and
// how later phases extend it: ./README.md.

jest.setTimeout(300_000);

const ISSUER = 'open-emarsys/core';
const KID = 'k1';
const repoDir = path.resolve(__dirname, '../../../..');

/**
 * Every `@Public()` route. Adding one is a security decision: it must be listed here, or the
 * suite fails.
 */
const PUBLIC_ROUTES = [
  'GET /healthz',
  'GET /readyz',
  'GET /.well-known/jwks.json',
  'POST /admin/v1/auth/login',
  'POST /admin/v1/auth/mfa/verify',
  'POST /admin/v1/auth/refresh',
  'POST /admin/v1/invitations/:token/accept',
  'POST /api/v3/oauth/token',
  'POST /internal/v1/service-token',
];

interface Fixtures {
  tenantA: string;
  tenantB: string;
  adminA: string;
  adminB: string;
  viewerB: string;
  roleB: string;
  adminRoleB: string;
  clientB: string;
}

interface CrossTenantCase {
  /** Concrete path aimed at a tenant-B resource. */
  path: string;
  body?: unknown;
  /** Throws if tenant B's resource changed (read with the RLS-bypassing superuser client). */
  unchanged: () => Promise<void>;
}

/**
 * NFR-8: one entry per non-public `/admin/v1` route with a path parameter, keyed like
 * `PUBLIC_ROUTES`. Tenant A's admin, holding every permission, aims it at a tenant-B resource
 * and must get 403 or 404, never data, and B's resource must stay unchanged.
 */
const CROSS_TENANT: Record<string, (f: Fixtures, su: PrismaClient) => CrossTenantCase> = {
  'GET /admin/v1/tenants/:id': (f, su) => ({
    path: `/admin/v1/tenants/${f.tenantB}`,
    unchanged: async () => void (await su.tenant.findUniqueOrThrow({ where: { id: f.tenantB } })),
  }),
  'PATCH /admin/v1/tenants/:id': (f, su) => ({
    path: `/admin/v1/tenants/${f.tenantB}`,
    body: { name: 'pwned', status: 'suspended' },
    unchanged: async () =>
      expect(await su.tenant.findUniqueOrThrow({ where: { id: f.tenantB } })).toMatchObject({ name: 'Tenant B', status: 'active' }),
  }),
  'PATCH /admin/v1/users/:id': (f, su) => ({
    path: `/admin/v1/users/${f.adminB}`,
    body: { name: 'pwned', status: 'disabled' },
    unchanged: async () =>
      expect(await su.user.findUniqueOrThrow({ where: { id: f.adminB } })).toMatchObject({ name: 'Admin B', status: 'active' }),
  }),
  'DELETE /admin/v1/users/:id': (f, su) => ({
    path: `/admin/v1/users/${f.viewerB}`,
    unchanged: async () => void (await su.user.findUniqueOrThrow({ where: { id: f.viewerB } })),
  }),
  'PATCH /admin/v1/roles/:id': (f, su) => ({
    path: `/admin/v1/roles/${f.roleB}`,
    body: { name: 'pwned', permissions: [{ module: 'identity', action: 'admin' }] },
    unchanged: async () =>
      expect(await su.role.findUniqueOrThrow({ where: { id: f.roleB }, include: { permissions: true } })).toMatchObject({
        name: 'Secret role B',
        permissions: [expect.objectContaining({ module: 'contacts', action: 'view' })],
      }),
  }),
  'DELETE /admin/v1/roles/:id': (f, su) => ({
    path: `/admin/v1/roles/${f.roleB}`,
    unchanged: async () => void (await su.role.findUniqueOrThrow({ where: { id: f.roleB } })),
  }),
  'POST /admin/v1/api-clients/:id/revoke': (f, su) => ({
    path: `/admin/v1/api-clients/${f.clientB}/revoke`,
    unchanged: async () =>
      expect(await su.apiClient.findUniqueOrThrow({ where: { id: f.clientB } })).toMatchObject({ revokedAt: null }),
  }),
};

/** Tenant-B strings that must never appear in a response to tenant A. */
const B_SECRETS = ['Tenant B', 'Admin B', 'admin@b.test', 'viewer@b.test', 'Secret role B', 'Client B'];

interface Route {
  key: string;
  method: string;
  path: string;
  isPublic: boolean;
  internal: boolean;
  operatorOnly: boolean;
  perms: string[];
}

/** Every HTTP route the app serves, with the auth metadata the guards read. */
function discoverRoutes(app: INestApplication): Route[] {
  const routes: Route[] = [];
  const meta = <T>(key: string, ...targets: object[]): T | undefined =>
    targets.map((t) => Reflect.getMetadata(key, t) as T | undefined).find((v) => v !== undefined);
  for (const wrapper of app.get(DiscoveryService).getControllers()) {
    const cls = wrapper.metatype as (new (...args: never[]) => object) | undefined;
    if (!cls) continue;
    for (const name of Object.getOwnPropertyNames(cls.prototype)) {
      const handler = (cls.prototype as Record<string, unknown>)[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (methodPath === undefined) continue;
      const method = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'][
        Reflect.getMetadata(METHOD_METADATA, handler) as number
      ]!;
      const full = `/${Reflect.getMetadata(PATH_METADATA, cls) ?? ''}/${methodPath}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
      const guards = [...(meta<unknown[]>(GUARDS_METADATA, cls) ?? []), ...(meta<unknown[]>(GUARDS_METADATA, handler) ?? [])];
      routes.push({
        key: `${method} ${full}`,
        method,
        path: full,
        // Metadata keys of @oe/ts-common/auth's Public, InternalOnly and RequirePermission.
        isPublic: meta<boolean>('oe:auth:public', handler, cls) ?? false,
        internal: meta<boolean>('oe:auth:internal', handler, cls) ?? false,
        operatorOnly: guards.includes(OperatorOnlyGuard),
        perms: meta<string[]>('oe:auth:permissions', handler, cls) ?? [],
      });
    }
  }
  return routes;
}

describe('security (full app: Postgres + NATS)', () => {
  let pg: StartedPostgreSqlContainer;
  let nats: StartedTestContainer;
  let core: PrismaClient;
  let su: PrismaClient;
  let app: INestApplication;
  let base: string;
  let tmp: string;
  let signer: JwtSigner;
  let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  let routes: Route[];
  let allPerms: string[];
  let f: Fixtures;

  const call = async (method: string, url: string, opts: { token?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  const user = (sub: string, tenant: string | null, perms: string[]) =>
    signer.sign({ sub, typ: 'user', tenant_id: tenant, perms }, 900);
  const service = () => signer.sign({ sub: 'segments', typ: 'service', tenant_id: null, scopes: allPerms }, 900);
  /** Concrete URL for a route: path params get a random UUID (guards run before pipes). */
  const concrete = (r: Route) => r.path.replace(/:[^/]+/g, () => randomUUID());
  const bodyFor = (r: Route) => (['POST', 'PATCH', 'PUT'].includes(r.method) ? {} : undefined);

  beforeAll(async () => {
    const db = await startTestDatabase();
    pg = db.container;
    core = db.prisma;
    su = new PrismaClient({ datasourceUrl: `${pg.getConnectionUri()}?schema=identity` });

    nats = await new GenericContainer('nats:2.11-alpine')
      .withCommand(['-js'])
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
      .start();
    const natsUrl = `nats://${nats.getHost()}:${nats.getMappedPort(4222)}`;
    const nc = await connect({ servers: natsUrl });
    const jsm = await nc.jetstreamManager();
    const streamsDir = path.join(repoDir, 'deploy/nats/streams');
    for (const file of readdirSync(streamsDir)) {
      await jsm.streams.add(JSON.parse(readFileSync(path.join(streamsDir, file), 'utf8')));
    }
    await nc.close();

    tmp = mkdtempSync(path.join(tmpdir(), 'oe-security-'));
    ({ privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }));
    writeFileSync(path.join(tmp, `${KID}.pem`), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const credentials = path.join(tmp, 'service-credentials.json');
    writeFileSync(credentials, JSON.stringify({ segments: { secret: randomBytes(32).toString('base64url'), scopes: [] } }));
    signer = JwtSigner.fromDir(tmp, ISSUER);

    // SystemPrismaModule, PrismaModule and HealthModule read DATABASE_URL themselves.
    process.env.DATABASE_URL = `postgresql://core:core@${pg.getHost()}:${pg.getPort()}/${pg.getDatabase()}?schema=identity`;
    const config: CoreConfig = { PORT: 0, DATABASE_URL: process.env.DATABASE_URL, NATS_URL: natsUrl, CORE_JWT_ISSUER: ISSUER };
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(config, {
          CORE_JWT_KEYS_DIR: tmp,
          CORE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
          CORE_SERVICE_CREDENTIALS: credentials,
        }),
      ],
    })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue({ sendMail: async () => undefined })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    const address = app.getHttpServer().address();
    base = `http://127.0.0.1:${typeof address === 'string' ? address : address.port}`;

    routes = discoverRoutes(app);
    allPerms = [
      ...new Set([
        ...PERMISSION_MODULES.flatMap((m) => PERMISSION_ACTIONS.map((a) => `${m}:${a}`)),
        ...routes.flatMap((r) => r.perms),
      ]),
    ];

    // Two tenants created by the operator through the API, as in production.
    const operator = await user(randomUUID(), null, allPerms);
    const createTenant = async (name: string) => {
      const res = await call('POST', '/admin/v1/tenants', {
        token: operator,
        body: { name, timezone: 'UTC', default_locale: 'es' },
      });
      expect(res.status).toBe(201);
      return (JSON.parse(res.text) as { id: string }).id;
    };
    const tenantA = await createTenant('Tenant A');
    const tenantB = await createTenant('Tenant B');
    const adminRole = (tenantId: string) => su.role.findFirstOrThrow({ where: { tenantId, name: 'Admin' } });
    const seedUser = async (tenantId: string, email: string, name: string) => {
      const u = await su.user.create({ data: { tenantId, email, name } });
      await su.userRole.create({ data: { userId: u.id, roleId: (await adminRole(tenantId)).id, tenantId } });
      return u.id;
    };
    const adminA = await seedUser(tenantA, 'admin@a.test', 'Admin A');
    const adminB = await seedUser(tenantB, 'admin@b.test', 'Admin B');
    const viewerB = await seedUser(tenantB, 'viewer@b.test', 'Viewer B');

    // Tenant B's own admin creates its resources through the API.
    const tokenB = await user(adminB, tenantB, allPerms);
    const role = await call('POST', '/admin/v1/roles', {
      token: tokenB,
      body: { name: 'Secret role B', permissions: [{ module: 'contacts', action: 'view' }] },
    });
    expect(role.status).toBe(201);
    const client = await call('POST', '/admin/v1/api-clients', {
      token: tokenB,
      body: { name: 'Client B', scopes: ['contacts:view'] },
    });
    expect(client.status).toBe(201);

    f = {
      tenantA,
      tenantB,
      adminA,
      adminB,
      viewerB,
      roleB: (JSON.parse(role.text) as { id: string }).id,
      adminRoleB: (await adminRole(tenantB)).id,
      clientB: (JSON.parse(client.text) as { id: string }).id,
    };
  });

  afterAll(async () => {
    await app?.close();
    await core?.$disconnect();
    await su?.$disconnect();
    await nats?.stop();
    await pg?.stop();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  describe('route inventory', () => {
    it('discovers the identity routes', () => {
      expect(routes.length).toBeGreaterThan(20);
      expect(routes.map((r) => r.key)).toEqual(expect.arrayContaining([...PUBLIC_ROUTES, ...Object.keys(CROSS_TENANT)]));
    });

    it('only the allow-listed routes are @Public', () => {
      expect(routes.filter((r) => r.isPublic).map((r) => r.key).sort()).toEqual([...PUBLIC_ROUTES].sort());
    });

    it('every /admin/v1 route with a path parameter has a cross-tenant case', () => {
      const missing = routes
        .filter((r) => !r.isPublic && r.path.startsWith('/admin/v1/') && r.path.includes(':'))
        .map((r) => r.key)
        .filter((k) => !(k in CROSS_TENANT));
      expect(missing).toEqual([]);
    });
  });

  describe('authentication (D7)', () => {
    it('rejects every non-public route without a token, with an expired token and with a forged one', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expired = await new SignJWT({ typ: 'user', tenant_id: f.tenantA, perms: allPerms })
        .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
        .setSubject(f.adminA)
        .setIssuer(ISSUER)
        .setIssuedAt(now - 3600)
        .setExpirationTime(now - 1800)
        .sign(privateKey);
      const forged = await new SignJWT({ typ: 'user', tenant_id: f.tenantA, perms: allPerms })
        .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
        .setSubject(f.adminA)
        .setIssuer(ISSUER)
        .setIssuedAt(now)
        .setExpirationTime(now + 900)
        .sign(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);

      const failures: string[] = [];
      for (const r of routes.filter((x) => !x.isPublic)) {
        for (const [label, token] of [
          ['no token', undefined],
          ['expired token', expired],
          ['forged token', forged],
        ] as const) {
          const res = await call(r.method, concrete(r), { token, body: bodyFor(r) });
          if (res.status !== 401) failures.push(`${r.key} with ${label}: ${res.status}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it('rejects typ=service tokens outside /internal and user tokens on /internal', async () => {
      const serviceToken = await service();
      const userToken = await user(f.adminA, f.tenantA, allPerms);
      const failures: string[] = [];
      for (const r of routes.filter((x) => !x.isPublic)) {
        expect(r.internal).toBe(r.path.startsWith('/internal/'));
        const res = await call(r.method, concrete(r), { token: r.internal ? userToken : serviceToken, body: bodyFor(r) });
        if (res.status !== 403) failures.push(`${r.key}: ${res.status}`);
      }
      expect(failures).toEqual([]);
      expect((await call('GET', '/internal/v1/revocations', { token: serviceToken })).status).toBe(200);
    });
  });

  describe('permission matrix (FR-2)', () => {
    it('every @RequirePermission route answers 403 to a role lacking that permission, and not to one holding it', async () => {
      const guarded = routes.filter((r) => r.perms.length && !r.internal);
      expect(guarded.length).toBeGreaterThan(10);
      const failures: string[] = [];
      for (const r of guarded) {
        // Operator-only routes (x-operator-only) are exercised with an operator principal, so the
        // 403 can only come from the missing permission.
        const [sub, tenant] = r.operatorOnly ? [randomUUID(), null] : [f.adminA, f.tenantA];
        for (const perm of r.perms) {
          const res = await call(r.method, concrete(r), {
            token: await user(sub, tenant, allPerms.filter((p) => p !== perm)),
            body: bodyFor(r),
          });
          if (res.status !== 403) failures.push(`${r.key} without ${perm}: ${res.status}`);
        }
        // Control: random ids and empty bodies make this a harmless 400/404, never a 401/403.
        const ok = await call(r.method, concrete(r), { token: await user(sub, tenant, allPerms), body: bodyFor(r) });
        if ([401, 403].includes(ok.status)) failures.push(`${r.key} with every permission: ${ok.status}`);
      }
      expect(failures).toEqual([]);
    });
  });

  describe('cross-tenant access (NFR-8)', () => {
    it("tenant A's full-permission admin gets 403/404 for tenant B's resources by id, which stay unchanged", async () => {
      const token = await user(f.adminA, f.tenantA, allPerms);
      const failures: string[] = [];
      for (const [key, make] of Object.entries(CROSS_TENANT)) {
        const c = make(f, su);
        const res = await call(key.split(' ')[0]!, c.path, { token, body: c.body });
        if (![403, 404].includes(res.status)) failures.push(`${key}: ${res.status} ${res.text}`);
        const leaked = B_SECRETS.filter((s) => res.text.includes(s));
        if (leaked.length) failures.push(`${key} leaked ${leaked.join(', ')}`);
        await c.unchanged().catch((err: unknown) => failures.push(`${key} changed tenant B: ${String(err)}`));
      }
      expect(failures).toEqual([]);
    });

    it("no list endpoint shows tenant A anything of tenant B's", async () => {
      const token = await user(f.adminA, f.tenantA, allPerms);
      const ids = [f.tenantB, f.adminB, f.viewerB, f.roleB, f.adminRoleB, f.clientB];
      const lists = routes.filter((r) => r.method === 'GET' && r.path.startsWith('/admin/v1/') && !r.path.includes(':'));
      expect(lists.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const r of lists) {
        const res = await call('GET', r.path, { token });
        const leaked = [...B_SECRETS, ...ids].filter((s) => res.text.includes(s));
        if (leaked.length) failures.push(`${r.key} (${res.status}) leaked ${leaked.join(', ')}`);
      }
      expect(failures).toEqual([]);
      const audit = await call('GET', `/admin/v1/audit-log?actor_id=${f.adminB}`, { token });
      expect(audit.status).toBe(200);
      expect(JSON.parse(audit.text).items).toEqual([]);
    });

    it("cannot grant or invite with tenant B's role ids", async () => {
      const token = await user(f.adminA, f.tenantA, allPerms);
      const patch = await call('PATCH', `/admin/v1/users/${f.adminA}`, { token, body: { role_ids: [f.adminRoleB] } });
      expect([400, 403, 404, 422]).toContain(patch.status);
      expect(await su.userRole.findMany({ where: { userId: f.adminA, roleId: f.adminRoleB } })).toEqual([]);

      const invite = await call('POST', '/admin/v1/users/invitations', {
        token,
        body: { email: 'mole@a.test', role_ids: [f.adminRoleB] },
      });
      expect([400, 403, 404, 422]).toContain(invite.status);
      expect(await su.invitation.findMany({ where: { email: 'mole@a.test' } })).toEqual([]);
    });
  });

  describe('audit (FR-6)', () => {
    it("records the operator's own actions (tenant_id null) despite RLS", async () => {
      // AuditInterceptor writes after responding; give it a moment.
      for (let i = 0; i < 50; i++) {
        if ((await su.auditLog.count({ where: { tenantId: null, resourceType: 'tenants' } })) >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await su.auditLog.count({ where: { tenantId: null, resourceType: 'tenants' } })).toBeGreaterThanOrEqual(2);
    });
  });

  describe('error responses', () => {
    it('a 500 is problem+json without stack traces, source paths or SQL', async () => {
      // A real failure inside a handler: take the table away from the service role.
      await su.$executeRawUnsafe('REVOKE SELECT ON identity.roles FROM core');
      try {
        const res = await call('GET', '/admin/v1/roles', { token: await user(f.adminA, f.tenantA, allPerms) });
        expect(res.status).toBe(500);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
        expect(res.text).not.toMatch(/\bat .+:\d+:\d+|\.ts\b|\.js\b|node_modules|prisma|permission denied|SELECT|identity\./i);
      } finally {
        await su.$executeRawUnsafe('GRANT SELECT ON identity.roles TO core');
      }
    });
  });
});
