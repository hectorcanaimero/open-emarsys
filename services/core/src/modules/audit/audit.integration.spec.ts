import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Principal } from '@oe/ts-common/auth';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { TenantContext } from '@oe/ts-common/tenant';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AuditConsumer } from './audit-consumer.js';
import { AuditLogController } from './audit-log.controller.js';
import { PostgresAuditSink } from './postgres-audit-sink.js';

jest.setTimeout(180_000);

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';
const ADMIN_A = '0192f000-0000-7000-8000-0000000000a1';

const coreDir = path.resolve(__dirname, '../../..');
const initSql = path.resolve(coreDir, '../../deploy/postgres/init/00-roles.sql');
const ROLES = [
  'CORE',
  'IMPORTER',
  'SEGMENTS',
  'CONTENT',
  'CAMPAIGNS',
  'DISPATCHER',
  'AUTOMATION',
  'ML',
  'ANALYTICS',
  'LOYALTY',
  'CONNECTORS',
  'TEMPORAL',
];

function admin(tenantId: string): Principal {
  return {
    sub: ADMIN_A,
    typ: 'user',
    tenant_id: tenantId,
    perms: ['identity:admin'],
    iat: 0,
    exp: 0,
  };
}

// Same setup as identity-schema.spec.ts: a real Postgres with RLS, migrated and used as the
// non-superuser `core` role FORCE ROW LEVEL SECURITY actually applies to.
describe('audit module (Postgres via testcontainers, FR-6)', () => {
  let container: StartedPostgreSqlContainer;
  let base: PrismaClient;
  let prisma: PrismaClient;
  let sink: PostgresAuditSink;
  let consumer: AuditConsumer;
  let controller: AuditLogController;

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
    sink = new PostgresAuditSink(prisma);
    consumer = new AuditConsumer(prisma);
    controller = new AuditLogController(prisma);
  });

  afterAll(async () => {
    await base?.$disconnect();
    await container?.stop();
  });

  it('records actor, timestamp, resource and tenant for a user deletion', async () => {
    await sink.record({
      tenant_id: A,
      actor_type: 'user',
      actor_id: ADMIN_A,
      action: 'users.delete',
      resource_type: 'users',
      resource_id: 'u-deleted-1',
      diff: null,
      at: '2026-09-18T10:00:00.000Z',
    });

    const [entry] = await as(A, () => prisma.auditLog.findMany({ where: { action: 'users.delete' } }));
    expect(entry).toMatchObject({
      tenantId: A,
      actorType: 'user',
      actorId: ADMIN_A,
      action: 'users.delete',
      resourceType: 'users',
      resourceId: 'u-deleted-1',
    });
    expect(entry?.at.toISOString()).toBe('2026-09-18T10:00:00.000Z');
  });

  it('redacts a password change diff before persisting it', async () => {
    await sink.record({
      tenant_id: A,
      actor_type: 'user',
      actor_id: ADMIN_A,
      action: 'users.update',
      resource_type: 'users',
      resource_id: 'u-2',
      diff: { email: 'ana@a.test', password: 'hunter2', mfa_recovery_code: 'xyz' },
      at: '2026-09-18T10:05:00.000Z',
    });

    const [entry] = await as(A, () => prisma.auditLog.findMany({ where: { resourceId: 'u-2' } }));
    expect(entry?.diff).toEqual({ email: 'ana@a.test', password: '[REDACTED]', mfa_recovery_code: '[REDACTED]' });
  });

  it('persists a system.audit.recorded event only once when delivered twice', async () => {
    const envelope = {
      id: '0192f000-1111-7000-8000-000000000001',
      type: 'system.audit.recorded',
      schema_version: 1,
      tenant_id: B,
      occurred_at: '2026-09-18T10:10:00.000Z',
      source: 'campaigns',
      contact_id: null,
      data: {
        actor_type: 'user' as const,
        actor_id: 'user-in-campaigns',
        action: 'contacts.delete',
        resource_type: 'contacts',
        resource_id: 'c-1',
        diff: null,
      },
    };

    await consumer.onAuditRecorded(envelope);
    await consumer.onAuditRecorded(envelope);

    const rows = await as(B, () => prisma.auditLog.findMany({ where: { id: envelope.id } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: B, action: 'contacts.delete', resourceId: 'c-1' });
  });

  it("does not let tenant A's admin see tenant B's entries", async () => {
    await sink.record({
      tenant_id: B,
      actor_type: 'user',
      actor_id: 'other-admin',
      action: 'users.delete',
      resource_type: 'users',
      resource_id: 'u-in-b',
      diff: null,
      at: '2026-09-18T10:15:00.000Z',
    });

    const page = await controller.list({}, admin(A));
    expect(page.items.some((item) => item.tenant_id === B)).toBe(false);
    expect(page.items.every((item) => item.tenant_id === A)).toBe(true);

    await expect(as(A, () => prisma.auditLog.findFirst({ where: { resourceId: 'u-in-b' } }))).resolves.toBeNull();
  });

  it('paginates by cursor, newest first', async () => {
    for (let i = 0; i < 3; i++) {
      await sink.record({
        tenant_id: A,
        actor_type: 'user',
        actor_id: ADMIN_A,
        action: 'roles.update',
        resource_type: 'roles',
        resource_id: `r-${i}`,
        diff: null,
        at: new Date(2026, 8, 18, 11, 0, i).toISOString(),
      });
    }

    const first = await controller.list({ limit: '2', resource_type: 'roles' }, admin(A));
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    expect(first.items.map((i) => i.resource_id)).toEqual(['r-2', 'r-1']);

    const second = await controller.list({ limit: '2', resource_type: 'roles', cursor: first.next_cursor! }, admin(A));
    expect(second.items.map((i) => i.resource_id)).toEqual(['r-0']);
    expect(second.next_cursor).toBeNull();
  });
});
