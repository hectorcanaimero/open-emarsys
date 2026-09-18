import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthModule, LocalKeyVerifier } from '@oe/ts-common/auth';
import { NatsModule } from '@oe/ts-common/nats';
import { TenantContext } from '@oe/ts-common/tenant';
import type { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { connect } from 'nats';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { PRISMA_CLIENT, PrismaModule } from '../../prisma/prisma.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { TenantsService } from '../tenants/tenants.service.js';
import { ContactsSharedModule } from './contacts-shared.module.js';
import { SYSTEM_FIELDS } from './system-fields.seeder.js';

jest.setTimeout(180_000);

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';

const coreDir = path.resolve(__dirname, '../../..');
const repoDir = path.resolve(coreDir, '../..');
const initSql = path.join(repoDir, 'deploy/postgres/init/00-roles.sql');
const ROLES = ['CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER', 'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL'];

// Migrated from the real init script and used as `core`, the non-superuser owner that
// FORCE ROW LEVEL SECURITY applies to.
describe('contacts schema (migration, RLS, system fields seeder)', () => {
  let pg: StartedPostgreSqlContainer;
  let nats: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaClient;

  const as = <T>(tenant: string, fn: () => Promise<T>) => TenantContext.run(tenant, async () => await fn());
  const addContact = (tenant: string, data: Record<string, string>) =>
    as(tenant, () => prisma.contact.create({ data: { tenantId: tenant, data } }));

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:17-alpine')
      .withEnvironment(Object.fromEntries(ROLES.map((r) => [`OE_PG_${r}_PASSWORD`, r.toLowerCase()])))
      .withCopyFilesToContainer([{ source: initSql, target: '/docker-entrypoint-initdb.d/00-roles.sql' }])
      .start();
    process.env.DATABASE_URL = `postgresql://core:core@${pg.getHost()}:${pg.getPort()}/${pg.getDatabase()}?schema=identity`;
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: coreDir, env: process.env, stdio: 'inherit' });

    nats = await new GenericContainer('nats:2.11-alpine')
      .withCommand(['-js'])
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
      .start();
    const natsUrl = `${nats.getHost()}:${nats.getMappedPort(4222)}`;
    const nc = await connect({ servers: natsUrl });
    const jsm = await nc.jetstreamManager();
    await jsm.streams.add(JSON.parse(readFileSync(path.join(repoDir, 'deploy/nats/streams/SYSTEM.json'), 'utf8')));
    await nc.close();

    const moduleRef = await Test.createTestingModule({
      imports: [
        NatsModule.forRoot({ servers: natsUrl, source: 'core-test' }),
        AuthModule.forRoot({ verifier: new LocalKeyVerifier({ keys: [] }, 'https://core.test') }),
        PrismaModule,
        TenantsModule,
        ContactsSharedModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PRISMA_CLIENT);
  });

  afterAll(async () => {
    await app?.close();
    await nats?.stop();
    await pg?.stop();
  });

  it('keeps emails unique per tenant, normalized, among live contacts', async () => {
    const ana = await addContact(A, { '3': ' Ana@Example.test ', '1': 'Ana' });
    expect(ana.emailNorm).toBe('ana@example.test');
    await expect(addContact(A, { '3': 'ana@example.test' })).rejects.toThrow(/Unique constraint/);
    await addContact(B, { '3': 'ana@example.test' });

    await as(A, () => prisma.contact.update({ where: { id: ana.id }, data: { deletedAt: new Date() } }));
    await addContact(A, { '3': 'ana@example.test' });
  });

  it('keeps external_id unique per tenant', async () => {
    await addContact(A, { '4': 'crm-1' });
    await expect(addContact(A, { '4': 'crm-1' })).rejects.toThrow(/Unique constraint/);
    await addContact(B, { '4': 'crm-1' });
  });

  it('hides other tenants rows and rejects writing them', async () => {
    const rows = await as(A, () => prisma.contact.findMany({ select: { tenantId: true } }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.tenantId === A)).toBe(true);
    await expect(as(A, () => prisma.contact.create({ data: { tenantId: B } }))).rejects.toThrow();
  });

  it('hands out custom field IDs per tenant from 1000', async () => {
    const next = (tenant: string) =>
      as(tenant, () =>
        prisma.$transaction(async (tx) => {
          const [row] = await tx.$queryRaw<{ id: number }[]>`SELECT contacts.next_custom_field_id(${tenant}::uuid) AS id`;
          return row!.id;
        })
      );
    expect([await next(A), await next(A), await next(B)]).toEqual([1000, 1001, 1000]);
  });

  it('keeps consents append-only', async () => {
    const contact = await addContact(A, { '3': 'consent@example.test' });
    const consent = { tenantId: A, contactId: contact.id, channel: 'email' as const, value: 1, source: 'api', text: 'Acepto' };
    await as(A, () => prisma.consent.create({ data: consent }));
    await expect(as(A, () => prisma.consent.updateMany({ data: { value: 2 } }))).rejects.toThrow(/permission denied/);
    await expect(as(A, () => prisma.consent.deleteMany())).rejects.toThrow(/permission denied/);
  });

  it('loads the system fields when a tenant is created', async () => {
    const tenant = await app.get(TenantsService).create({ name: 'Acme', timezone: 'UTC', default_locale: 'es' });
    const count = () => as(tenant.id, () => prisma.fieldDefinition.count());
    for (let i = 0; i < 50 && (await count()) < SYSTEM_FIELDS.length; i++) await new Promise((r) => setTimeout(r, 100));

    const fields = await as(tenant.id, () => prisma.fieldDefinition.findMany({ orderBy: { fieldId: 'asc' } }));
    expect(fields.map((f) => f.fieldId)).toEqual(SYSTEM_FIELDS.map((f) => f.field_id).sort((x, y) => x - y));
    expect(fields.every((f) => f.isSystem)).toBe(true);
    expect(fields.find((f) => f.fieldId === 3)).toMatchObject({ apiName: 'email', unique: true });
    expect(fields.find((f) => f.fieldId === 40)).toMatchObject({ readOnly: true });
  });
});
