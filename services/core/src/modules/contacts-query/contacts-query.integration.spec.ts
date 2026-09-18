import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import type { Principal } from '@oe/ts-common/auth';
import { TenantContext } from '@oe/ts-common/tenant';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PRISMA_CLIENT, PrismaModule } from '../../prisma/prisma.module.js';
import { SystemFieldsSeeder } from '../contacts-shared/system-fields.seeder.js';
import { ContactsQueryModule } from './contacts-query.module.js';
import { AdminContactsQueryController, InternalContactsQueryController, PublicContactsQueryController } from './contacts-query.controller.js';

jest.setTimeout(900_000);

const A = '0192f000-0000-7000-8000-00000000000a'; // 100,000 contacts
const B = '0192f000-0000-7000-8000-00000000000b'; // small, for isolation
const C = '0192f000-0000-7000-8000-00000000000c'; // 1,000,000 contacts
const pa = { tenant_id: A } as Principal;

const coreDir = path.resolve(__dirname, '../../..');
const initSql = path.resolve(coreDir, '../../deploy/postgres/init/00-roles.sql');
const ROLES = ['CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER', 'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL'];

describe('contacts-query', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let publicApi: PublicContactsQueryController;
  let admin: AdminContactsQueryController;
  let internal: InternalContactsQueryController;
  const as = <T>(tenant: string, fn: () => Promise<T>) => TenantContext.run(tenant, async () => await fn());
  const sql = (tenant: string, q: Prisma.Sql) => as(tenant, () => prisma.$transaction(async (tx) => tx.$executeRaw(q)));

  // Bulk seeding as the container's superuser: RLS does not apply, nor Prisma's 5 s transaction limit.
  const superuser = async (query: string, params: unknown[] = []) => {
    const c = new Client({ connectionString: pg.getConnectionUri() });
    await c.connect();
    await c.query(query, params);
    await c.end();
  };
  const seed = (tenant: string, n: number) =>
    superuser(
      `INSERT INTO contacts.contacts (tenant_id, data, updated_at)
       SELECT $1::uuid, jsonb_build_object('1', 'Name' || i, '2', 'Last' || i, '3', 'User' || i || '@Example.com', '4', 'ext-' || i), now() - i * interval '1 second'
       FROM generate_series(1, $2::int) i`,
      [tenant, n]
    );

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:17-alpine')
      .withEnvironment(Object.fromEntries(ROLES.map((r) => [`OE_PG_${r}_PASSWORD`, r.toLowerCase()])))
      .withCopyFilesToContainer([{ source: initSql, target: '/docker-entrypoint-initdb.d/00-roles.sql' }])
      .start();
    process.env.DATABASE_URL = `postgresql://core:core@${pg.getHost()}:${pg.getPort()}/${pg.getDatabase()}?schema=identity`;
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: coreDir, env: process.env, stdio: 'inherit' });

    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, ContactsQueryModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    prisma = moduleRef.get(PRISMA_CLIENT);
    publicApi = moduleRef.get(PublicContactsQueryController);
    admin = moduleRef.get(AdminContactsQueryController);
    internal = moduleRef.get(InternalContactsQueryController);
    const seeder = new SystemFieldsSeeder(prisma);
    for (const t of [A, B, C]) await seeder.seed(t);
    await seed(A, 100_000);
    await seed(B, 5);
    await seed(C, 1_000_000);
    await superuser('ANALYZE contacts.contacts');
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it('getdata returns only the requested fields and 2008 for missing keys', async () => {
    const r = await as(A, () => publicApi.getData(pa, { keyId: '3', keyValues: ['user1@example.com', ' USER2@example.com', 'nobody@example.com', 'user3@example.com'], fields: ['1', '3'] }));
    expect(r.result).toEqual([
      { id: expect.any(String), '1': 'Name1', '3': 'User1@Example.com' },
      { id: expect.any(String), '1': 'Name2', '3': 'User2@Example.com' },
      { id: expect.any(String), '1': 'Name3', '3': 'User3@Example.com' },
    ]);
    expect(r.errors).toEqual([{ index: 2, key: 'nobody@example.com', code: 2008, text: expect.any(String) }]);
    await expect(as(A, () => publicApi.getData(pa, { keyId: '3', keyValues: ['x@y.z'], fields: ['999'] }))).rejects.toMatchObject({ replyCode: 2011 });
    await expect(as(A, () => publicApi.getData(pa, { keyId: '1', keyValues: ['x'], fields: ['1'] }))).rejects.toMatchObject({ replyCode: 2009 });
  });

  it('searches an email prefix over 100,000 contacts in under 200 ms', async () => {
    const t0 = performance.now();
    const page = await as(A, () => admin.search(pa, 'user4242'));
    const ms = performance.now() - t0;
    console.log(`prefix search: ${ms.toFixed(1)} ms`);
    expect(page.items.map((i) => i.fields['3'])).toContain('User4242@Example.com');
    expect(page.items.length).toBe(11); // user4242 + user42420..user42429
    expect(ms).toBeLessThan(200);

    expect((await as(A, () => admin.search(pa, 'name77'))).items[0]?.fields['1']).toMatch(/^Name77/);
    expect((await as(A, () => admin.search(pa, 'ext-99999'))).items[0]?.fields['4']).toBe('ext-99999');
    expect((await as(B, () => admin.search({ tenant_id: B } as Principal, 'user4242'))).items).toEqual([]);
  });

  it('paginates by (updated_at, id) and filters on fields', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const page = await as(A, () => admin.search(pa, undefined, undefined, '1,3', cursor, '25'));
      seen.push(...page.items.map((x) => x.id));
      cursor = page.next_cursor ?? undefined;
    }
    expect(new Set(seen).size).toBe(100);
    expect(cursor).toBeDefined();
    // most recently updated first: Name1 is the newest row
    const first = await as(A, () => admin.search(pa, undefined, undefined, '1', undefined, '2'));
    expect(first.items.map((i) => i.fields)).toEqual([{ '1': 'Name1' }, { '1': 'Name2' }]);

    const f = await as(A, () => admin.search(pa, undefined, ['2:starts_with:last9999', '1:neq:Name99990'], undefined, undefined, '50'));
    expect(f.items.map((i) => i.fields['2']).sort()).toEqual(['Last9999', 'Last99991', 'Last99992', 'Last99993', 'Last99994', 'Last99995', 'Last99996', 'Last99997', 'Last99998', 'Last99999']);
    await expect(as(A, () => admin.search(pa, undefined, ['777:eq:x']))).rejects.toThrow(/unknown field/);
    await expect(as(A, () => admin.search(pa, undefined, ['1:bogus:x']))).rejects.toThrow(/invalid filter/);
    await expect(as(A, () => admin.search(pa, undefined, undefined, undefined, 'garbage'))).rejects.toThrow(/cursor/);
  });

  it('shows a profile with labels, consents and lists', async () => {
    const id = (await as(B, () => admin.search({ tenant_id: B } as Principal, 'user1@'))).items[0]?.id as string;
    await sql(B, Prisma.sql`UPDATE contacts.contacts SET data = data || '{"31": 1, "32": 2}' WHERE id = ${id}::uuid`);
    await sql(B, Prisma.sql`WITH l AS (INSERT INTO contacts.lists (tenant_id, name) VALUES (${B}::uuid, 'VIP') RETURNING id)
      INSERT INTO contacts.list_members (list_id, contact_id, tenant_id) SELECT id, ${id}::uuid, ${B}::uuid FROM l`);
    const p = await as(B, () => admin.profile({ tenant_id: B } as Principal, id));
    expect(p).toMatchObject({ id, consents: { email: 1, sms: 2, push: null }, lists: [{ name: 'VIP' }], labels: { '1': 'Nombre', '3': 'Email' } });
    expect(p.fields['3']).toBe('User1@Example.com');
    await expect(as(A, () => admin.profile(pa, id))).rejects.toThrow(/not found/); // other tenant
  });

  it('looks up 5,000 contacts by ID in one call', async () => {
    const ids = (await as(A, () => admin.search(pa, undefined, undefined, '1', undefined, '200'))).items.map((i) => i.id);
    const all = await as(A, async () =>
      prisma.$transaction(async (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM contacts.contacts WHERE tenant_id = ${A}::uuid LIMIT 5000`)
    );
    const r = await internal.lookup({ tenant_id: A, contact_ids: [...all.slice(0, 4999).map((x) => x.id), '0192f000-0000-7000-8000-0000000000ff'], field_ids: [1, 3, 500] });
    expect(Object.keys(r.contacts)).toHaveLength(4999);
    expect(Object.values(r.contacts)[0]).toEqual({ '1': expect.any(String), '3': expect.any(String) });
    expect(ids).toHaveLength(200);
    await expect(internal.lookup({ tenant_id: A, contact_ids: [], field_ids: [1] })).rejects.toThrow();
  });

  it('streams 1,000,000 contacts in a separate process that stays under 300 MB', async () => {
    const url = new URL(process.env.DATABASE_URL as string);
    const { stdout } = await promisify(execFile)('pnpm', ['exec', 'tsx', 'src/modules/contacts-query/testing/stream-child.ts', C, '1,3'], {
      cwd: coreDir,
      env: { ...process.env, DATABASE_URL: url.toString() },
      maxBuffer: 1 << 20,
    });
    const out = JSON.parse(stdout.trim().split('\n').pop() as string) as { lines: number; peakRssMb: number };
    console.log(`stream child: ${out.lines} lines, peak rss ${out.peakRssMb} MB`);
    expect(out.lines).toBe(1_000_000);
    expect(out.peakRssMb).toBeLessThan(300);
  });

  it('serves the 1,000,000 contacts over HTTP as NDJSON', async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    let lines = 0;
    let first = '';
    await new Promise<void>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/internal/v1/contacts/stream?tenant_id=${C}&fields=1,3`, (res) => {
          expect(res.headers['content-type']).toContain('application/x-ndjson');
          res.on('data', (buf: Buffer) => {
            if (!first) first = buf.toString('utf8', 0, buf.indexOf(10));
            for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++;
          });
          res.on('end', resolve);
          res.on('error', reject);
        })
        .on('error', reject);
    });
    expect(lines).toBe(1_000_000);
    expect(JSON.parse(first)).toEqual({ id: expect.any(String), fields: { '1': expect.any(String), '3': expect.any(String) } });
  });

  it('streams only list members and 404s an unknown list', async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const get = (qs: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) =>
        http.get(`http://127.0.0.1:${port}/internal/v1/contacts/stream?${qs}`, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }).on('error', reject)
      );
    const [{ id: listId }] = await as(B, () => prisma.$transaction(async (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM contacts.lists LIMIT 1`));
    const ok = await get(`tenant_id=${B}&fields=3&list_id=${listId}`);
    expect(ok.body.trim().split('\n')).toHaveLength(1);
    expect((await get(`tenant_id=${B}&fields=3&list_id=0192f000-0000-7000-8000-0000000000ff`)).status).toBe(404);
    expect((await get(`tenant_id=${B}&fields=x`)).status).toBe(400);
    expect((await get(`tenant_id=${B}&fields=3`)).body.trim().split('\n')).toHaveLength(5);
  });
});
