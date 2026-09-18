import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { TenantContext } from '@oe/ts-common/tenant';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

jest.setTimeout(180_000);

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';

const coreDir = path.resolve(__dirname, '../../..');
const initSql = path.resolve(coreDir, '../../deploy/postgres/init/00-roles.sql');
const ROLES = ['CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER', 'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL'];

// Clean database set up by the real init script, migrated and used as the `core` role:
// a non-superuser that owns the tables, which is what FORCE ROW LEVEL SECURITY is for.
describe('identity schema (migration + RLS)', () => {
  let container: StartedPostgreSqlContainer;
  let base: PrismaClient;
  let prisma: PrismaClient;

  const as = <T>(tenant: string, fn: () => Promise<T>) => TenantContext.run(tenant, async () => await fn());

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

    base = new PrismaClient({ datasourceUrl: url });
    prisma = withTenantScope(base);
    for (const [id, email] of [[A, 'ana@a.test'], [B, 'bob@b.test']]) {
      await as(id, async () => {
        await prisma.tenant.create({ data: { id, name: id, timezone: 'UTC' } });
        await prisma.user.create({ data: { tenantId: id, email } });
      });
    }
  });

  afterAll(async () => {
    await base?.$disconnect();
    await container?.stop();
  });

  it('shows tenant A only its own tenant and users', async () => {
    const users = await as(A, () => prisma.user.findMany());
    expect(users.map((u) => u.email)).toEqual(['ana@a.test']);
    expect((await as(A, () => prisma.tenant.findMany())).map((t) => t.id)).toEqual([A]);
    expect(await as(A, () => prisma.user.findFirst({ where: { tenantId: B } }))).toBeNull();
  });

  it('rejects writing rows for another tenant', async () => {
    await expect(as(A, () => prisma.user.create({ data: { tenantId: B, email: 'x@b.test' } }))).rejects.toThrow();
  });

  it('keeps emails unique per tenant, case-insensitively', async () => {
    await expect(as(A, () => prisma.user.create({ data: { tenantId: A, email: 'ANA@a.test' } }))).rejects.toThrow();
    await as(B, () => prisma.user.create({ data: { tenantId: B, email: 'ana@a.test' } }));
  });

  it('generates UUID v7 ids', async () => {
    const [user] = await as(A, () => prisma.user.findMany());
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('keeps audit_log append-only', async () => {
    const entry = { tenantId: A, actorType: 'user' as const, actorId: 'u1', action: 'user.created', resourceType: 'user' };
    await as(A, () => prisma.auditLog.create({ data: entry }));
    await expect(as(A, () => prisma.auditLog.updateMany({ data: { action: 'tampered' } }))).rejects.toThrow(/permission denied/);
    await expect(as(A, () => prisma.auditLog.deleteMany())).rejects.toThrow(/permission denied/);
    expect(await as(A, () => prisma.auditLog.count())).toBe(1);
  });
});
