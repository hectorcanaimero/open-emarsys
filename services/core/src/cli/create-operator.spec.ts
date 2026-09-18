import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { withSystemScope, withTenantScope } from '@oe/ts-common/prisma-tenant';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SYSTEM_DB_ROLE } from '../modules/tenants/system-prisma.module.js';
import { createOperator } from './create-operator.js';

jest.setTimeout(180_000);

const coreDir = path.resolve(__dirname, '../..');
const initSql = path.resolve(coreDir, '../../deploy/postgres/init/00-roles.sql');
const ROLES = [
  'CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER',
  'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL',
];

describe('create-operator CLI (idempotent bootstrap, FR-1)', () => {
  let pg: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

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
    prisma = withTenantScope(new PrismaClient({ datasourceUrl: dbUrl }), { systemRole: SYSTEM_DB_ROLE });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('creates the operator with a hashed password and the Operator role', async () => {
    const result = await createOperator(prisma, { email: 'root@open-emarsys.test', password: 'correct-horse-battery' });
    expect(result.created).toBe(true);

    const user = await withSystemScope(() => prisma.user.findUniqueOrThrow({ where: { id: result.userId } }));
    expect(user.tenantId).toBeNull();
    expect(user.passwordHash).toBeTruthy();
    expect(user.passwordHash).not.toContain('correct-horse-battery');

    const roles = await withSystemScope(() =>
      prisma.userRole.findMany({ where: { userId: user.id }, include: { role: { include: { permissions: true } } } })
    );
    expect(roles).toHaveLength(1);
    expect(roles[0]!.role.name).toBe('Operator');
    expect(roles[0]!.role.permissions.map((p) => `${p.module}:${p.action}`).sort()).toEqual([
      'tenants:admin',
      'tenants:view',
    ]);
  });

  it('is idempotent: re-running with the same email is a no-op', async () => {
    const first = await createOperator(prisma, { email: 'idempotent@open-emarsys.test', password: 'correct-horse-battery' });
    const second = await createOperator(prisma, { email: 'IDEMPOTENT@open-emarsys.test', password: 'another-password-1' });

    expect(second.created).toBe(false);
    expect(second.userId).toBe(first.userId);

    const count = await withSystemScope(() =>
      prisma.user.count({ where: { tenantId: null, email: { equals: 'idempotent@open-emarsys.test', mode: 'insensitive' } } })
    );
    expect(count).toBe(1);
  });

  it('does not create a second Operator role when one already exists', async () => {
    await createOperator(prisma, { email: 'second-op@open-emarsys.test', password: 'correct-horse-battery' });
    const operatorRoles = await withSystemScope(() =>
      prisma.role.findMany({ where: { tenantId: null, name: 'Operator' } })
    );
    expect(operatorRoles).toHaveLength(1);
  });
});
