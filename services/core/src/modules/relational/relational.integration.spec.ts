import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Principal } from '@oe/ts-common/auth';
import { TenantContext } from '@oe/ts-common/tenant';
import type { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PRISMA_CLIENT, PrismaModule } from '../../prisma/prisma.module.js';
import { SystemFieldsSeeder } from '../contacts-shared/system-fields.seeder.js';
import { InternalRelationalController, PublicRelationalController, RelationalController } from './relational.controller.js';
import { RelationalModule } from './relational.module.js';

jest.setTimeout(180_000);

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';
const pa = { tenant_id: A } as Principal;
const pb = { tenant_id: B } as Principal;

const coreDir = path.resolve(__dirname, '../../..');
const initSql = path.resolve(coreDir, '../../deploy/postgres/init/00-roles.sql');
const ROLES = ['CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER', 'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL'];

describe('relational tables', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let admin: RelationalController;
  let publicApi: PublicRelationalController;
  let internal: InternalRelationalController;
  let contactId: string;
  const as = <T>(tenant: string, fn: () => Promise<T>) => TenantContext.run(tenant, async () => await fn());

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:17-alpine')
      .withEnvironment(Object.fromEntries(ROLES.map((r) => [`OE_PG_${r}_PASSWORD`, r.toLowerCase()])))
      .withCopyFilesToContainer([{ source: initSql, target: '/docker-entrypoint-initdb.d/00-roles.sql' }])
      .start();
    process.env.DATABASE_URL = `postgresql://core:core@${pg.getHost()}:${pg.getPort()}/${pg.getDatabase()}?schema=identity`;
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: coreDir, env: process.env, stdio: 'inherit' });

    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, RelationalModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PRISMA_CLIENT);
    admin = moduleRef.get(RelationalController);
    publicApi = moduleRef.get(PublicRelationalController);
    internal = moduleRef.get(InternalRelationalController);
    const seeder = new SystemFieldsSeeder(prisma);
    await seeder.seed(A);
    await seeder.seed(B);
    contactId = (await as(A, () => prisma.contact.create({ data: { tenantId: A, data: { '3': 'ana@example.test' } } }))).id;
    await as(A, () => prisma.contact.create({ data: { tenantId: A, data: { '3': 'luis@example.test' } } }));
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it('creates "mascotas", loads 3 rows through the public API, reads them on the contact and rejects a bad type', async () => {
    const table = await as(A, () =>
      admin.create(pa, {
        name: 'mascotas',
        key_field: 'nombre',
        columns: [
          { name: 'nombre', type: 'text' },
          { name: 'especie', type: 'text' },
          { name: 'edad', type: 'number' },
        ],
      })
    );
    await expect(as(A, () => admin.create(pa, { name: 'mascotas', key_field: 'nombre', columns: [{ name: 'nombre', type: 'text' }] }))).rejects.toThrow(/already exists/);
    await expect(as(A, () => admin.create(pa, { name: 'x', key_field: 'nope', columns: [{ name: 'nombre', type: 'text' }] }))).rejects.toThrow();

    const put = (rows: { key_value: string; row_key: string; data: Record<string, unknown> }[]) =>
      as(A, async () => publicApi.upsert(pa, table.id, { key_id: '3', rows }));
    const ok = await put([
      { key_value: 'ana@example.test', row_key: 'rex', data: { nombre: 'Rex', especie: 'perro', edad: '3' } },
      { key_value: 'ANA@example.test', row_key: 'misu', data: { nombre: 'Misu', especie: 'gato', edad: 5 } },
      { key_value: 'ana@example.test', row_key: 'kiwi', data: { nombre: 'Kiwi', especie: 'loro' } },
    ]);
    expect(ok).toEqual({ upserted: 3, errors: [] });

    const card = await as(A, () => admin.rowsOf(pa, contactId, table.id, 50));
    expect(card.items.map((r) => [r.key, r.data])).toEqual([
      ['kiwi', { nombre: 'Kiwi', especie: 'loro' }],
      ['misu', { nombre: 'Misu', especie: 'gato', edad: 5 }],
      ['rex', { nombre: 'Rex', especie: 'perro', edad: 3 }],
    ]);
    expect(card.next_cursor).toBeNull();

    // partial success: bad type, unknown column, unknown contact; the valid row still lands
    const partial = await put([
      { key_value: 'ana@example.test', row_key: 'rex', data: { edad: 'muy viejo' } },
      { key_value: 'ana@example.test', row_key: 'bob', data: { color: 'rojo' } },
      { key_value: 'nadie@example.test', row_key: 'bob', data: { nombre: 'Bob' } },
      { key_value: 'luis@example.test', row_key: 'toby', data: { nombre: 'Toby', especie: 'perro' } },
    ]);
    expect(partial.upserted).toBe(1);
    expect(partial.errors.map((e) => [e.index, e.code])).toEqual([[0, 2010], [1, 2011], [2, 2008]]);
    // the rejected update left Rex untouched
    expect((await as(A, () => admin.rowsOf(pa, contactId, table.id, 50))).items.find((r) => r.key === 'rex')?.data).toMatchObject({ edad: 3 });

    // replace an existing row, and page by cursor
    await put([{ key_value: 'ana@example.test', row_key: 'rex', data: { nombre: 'Rex', especie: 'lobo' } }]);
    const page = await as(A, () => admin.rowsOf(pa, contactId, table.id, 2));
    expect(page.items.map((r) => r.key)).toEqual(['kiwi', 'misu']);
    const next = await as(A, () => admin.rowsOf(pa, contactId, table.id, 2, page.next_cursor!));
    expect(next.items.map((r) => [r.key, (r.data as { especie: string }).especie])).toEqual([['rex', 'lobo']]);
  });

  it('accepts internal batches, rejects an unknown key_id or table, and isolates tenants', async () => {
    const [table] = (await as(A, () => admin.list(pa, '50'))).items;
    const res = await internal.upsert(table!.id, { tenant_id: A, key_id: '3', rows: [{ key_value: 'luis@example.test', row_key: 'nala', data: { nombre: 'Nala' } }] });
    expect(res).toEqual({ upserted: 1, errors: [] });
    await expect(publicApi.upsert(pa, table!.id, { key_id: '1', rows: [{ key_value: 'x', row_key: 'y', data: {} }] })).rejects.toMatchObject({ replyCode: 2009 });
    await expect(publicApi.upsert(pa, '0192f000-0000-7000-8000-0000000000ff', { key_id: '3', rows: [{ key_value: 'x', row_key: 'y', data: {} }] })).rejects.toMatchObject({ replyCode: 2017 });
    // tenant B sees neither the table nor its rows
    expect((await as(B, () => admin.list(pb, '50'))).items).toEqual([]);
    await expect(as(B, () => admin.rowsOf(pb, contactId, table!.id, 50))).rejects.toMatchObject({ replyCode: 2017 });
  });

  it('adds columns, refuses duplicates and deletes a table with its rows', async () => {
    const [table] = (await as(A, () => admin.list(pa, '50'))).items;
    const updated = await as(A, () => admin.update(pa, table!.id, { add_columns: [{ name: 'vacunado', type: 'boolean' }] }));
    expect(updated.columns.map((c) => c.name)).toEqual(['nombre', 'especie', 'edad', 'vacunado']);
    await expect(as(A, () => admin.update(pa, table!.id, { add_columns: [{ name: 'edad', type: 'text' }] }))).rejects.toThrow(/already exists/);

    await as(A, () => admin.remove(pa, table!.id));
    expect(await as(A, () => prisma.relationalRow.count())).toBe(0);
    await expect(as(A, () => admin.get(pa, table!.id))).rejects.toMatchObject({ replyCode: 2017 });
  });
});
