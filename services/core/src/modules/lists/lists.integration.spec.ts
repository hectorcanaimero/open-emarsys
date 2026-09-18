import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Principal } from '@oe/ts-common/auth';
import { type EventEnvelope, NATS_CONNECTION, NatsModule } from '@oe/ts-common/nats';
import { TenantContext } from '@oe/ts-common/tenant';
import type { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NatsConnection } from 'nats';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { PRISMA_CLIENT, PrismaModule } from '../../prisma/prisma.module.js';
import { SystemFieldsSeeder } from '../contacts-shared/system-fields.seeder.js';
import { PublicContactsWriteController } from '../contacts-write/contacts-write.controller.js';
import { ContactsWriteModule } from '../contacts-write/contacts-write.module.js';
import { OutboxRelay } from '../contacts-write/outbox.js';
import { AdminListsController, InternalListsController, PublicListsController } from './lists.controller.js';
import { ListsModule } from './lists.module.js';

jest.setTimeout(180_000);

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';
const user = (tenant: string) => ({ sub: 'u', typ: 'user', tenant_id: tenant, perms: ['contacts:edit', 'contacts:view'], iat: 0, exp: 0 }) as Principal;
const service = (tenant: string | null) => ({ sub: 'importer', typ: 'service', tenant_id: tenant, scopes: ['contacts:edit'], iat: 0, exp: 0 }) as Principal;

const coreDir = path.resolve(__dirname, '../../..');
const repoDir = path.resolve(coreDir, '../..');
const initSql = path.join(repoDir, 'deploy/postgres/init/00-roles.sql');
const ROLES = ['CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER', 'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL'];

type Upserted = EventEnvelope<{ lists: string[] }>;

describe('lists (FR-13)', () => {
  let pg: StartedPostgreSqlContainer;
  let nats: StartedTestContainer;
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let nc: NatsConnection;
  let relay: OutboxRelay;
  let contacts: PublicContactsWriteController;
  let api: PublicListsController;
  let admin: AdminListsController;
  let internal: InternalListsController;

  const as = <T>(tenant: string, fn: () => Promise<T>) => TenantContext.run(tenant, async () => await fn());
  const emails = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}@example.test`);
  const newList = async (name: string, tenant = A) => (await admin.create(user(tenant), { name })).id;
  const idOf = async (email: string, tenant = A) => (await as(tenant, () => prisma.contact.findFirstOrThrow({ where: { emailNorm: email } }))).id;

  const drain = async () => {
    while ((await relay.drain()) > 0);
  };
  const upserts = async (contactId: string) => {
    await drain();
    const jsm = await nc.jetstreamManager();
    const total = (await jsm.streams.info('CONTACTS')).state.messages;
    const out: Upserted[] = [];
    let seen = 0;
    const consumer = await nc.jetstream().consumers.get('CONTACTS');
    for await (const m of await consumer.fetch({ max_messages: total, expires: 5_000 })) {
      const e = m.json<Upserted>();
      if (e.type === 'contacts.upserted' && e.contact_id === contactId) out.push(e);
      if (++seen === total) break;
    }
    return out;
  };

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

    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, NatsModule.forRoot({ servers: `${nats.getHost()}:${nats.getMappedPort(4222)}`, source: 'core' }), ContactsWriteModule, ListsModule],
    }).compile();
    prisma = moduleRef.get(PRISMA_CLIENT);
    nc = moduleRef.get(NATS_CONNECTION);
    relay = moduleRef.get(OutboxRelay);
    contacts = moduleRef.get(PublicContactsWriteController);
    api = moduleRef.get(PublicListsController);
    admin = moduleRef.get(AdminListsController);
    internal = moduleRef.get(InternalListsController);

    const jsm = await nc.jetstreamManager();
    await jsm.streams.add(JSON.parse(readFileSync(path.join(repoDir, 'deploy/nats/streams/CONTACTS.json'), 'utf8')));
    const seeder = new SystemFieldsSeeder(prisma);
    await seeder.seed(A);
    await seeder.seed(B);
  });

  afterAll(async () => {
    await moduleRef?.close();
    await nats?.stop();
    await pg?.stop();
  });

  it('adding 500 contacts by API leaves the count at 500, and adding them again does not duplicate', async () => {
    const all = emails(500, 'bulk');
    await contacts.create(user(A), { key_id: '3', contacts: all.map((e) => ({ '3': e })) });
    const { id } = await api.create(user(A), { name: 'Bulk' });

    const first = await api.add(user(A), id, { key_id: '3', external_ids: all.slice(0, 250) });
    const second = await api.add(user(A), id, { key_id: '3', external_ids: all.slice(0, 250) });
    const rest = await api.add(user(A), id, { key_id: '3', external_ids: all.slice(200) });

    expect([first.count, second.count, rest.count]).toEqual([250, 0, 250]);
    expect(await api.count(user(A), id)).toEqual({ count: 500 });
    expect(await as(A, () => prisma.listMember.count({ where: { listId: id } }))).toBe(500);
  });

  it('reports unknown keys as errors without aborting the rest', async () => {
    const id = await newList('Partial');
    await contacts.create(user(A), { key_id: '3', contacts: [{ '3': 'p1@example.test' }, { '3': 'p2@example.test' }] });

    const res = await api.add(user(A), id, { key_id: '3', external_ids: ['p1@example.test', 'ghost@example.test', 'p2@example.test'] });

    expect(res.count).toBe(2);
    expect(res.errors).toEqual([{ index: 1, key: 'ghost@example.test', code: 2008, text: expect.any(String) }]);
    expect(await api.count(user(A), id)).toEqual({ count: 2 });
    await expect(api.add(user(A), id, { key_id: '1', external_ids: ['x'] })).rejects.toMatchObject({ replyCode: 2009 });
  });

  it('publishes contacts.upserted with the current lists on every add and remove', async () => {
    const one = await newList('Ev1');
    const two = await newList('Ev2');
    await contacts.create(user(A), { key_id: '3', contacts: [{ '3': 'ev@example.test' }] });
    const contactId = await idOf('ev@example.test');
    await drain();

    await api.add(user(A), one, { key_id: '3', external_ids: ['ev@example.test'] });
    await admin.addMembers(user(A), two, { contact_ids: [contactId] });
    await api.remove(user(A), one, { key_id: '3', external_ids: ['ev@example.test'] });
    await api.add(user(A), two, { key_id: '3', external_ids: ['ev@example.test'] }); // already there: no event

    const events = (await upserts(contactId)).slice(1); // skip the creation event
    expect(events.map((e) => [...e.data.lists].sort())).toEqual([[one], [one, two].sort(), [two]]);
  });

  it('admin: CRUD, paginated members, contact lists, not_found ids, tenant isolation', async () => {
    const id = await newList('Admin');
    await expect(admin.create(user(A), { name: 'Admin' })).rejects.toMatchObject({ status: 409 });
    expect(await admin.update(user(A), id, { name: 'Admin 2' })).toMatchObject({ name: 'Admin 2', member_count: 0, description: null });

    await contacts.create(user(A), { key_id: '3', contacts: emails(5, 'adm').map((e) => ({ '3': e, '1': 'N' })) });
    const ids = await Promise.all(emails(5, 'adm').map((e) => idOf(e)));
    const ghost = '0192f000-0000-7000-8000-0000000000ff';
    expect(await admin.addMembers(user(A), id, { contact_ids: [...ids, ghost] })).toEqual({ changed: 5, not_found: [ghost] });

    const p1 = await admin.members(user(A), id, { limit: '3' });
    const p2 = await admin.members(user(A), id, { limit: '3', cursor: p1.next_cursor! });
    expect(p1.items).toHaveLength(3);
    expect(p2.items).toHaveLength(2);
    expect(p2.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((m) => m.contact_id))).toEqual(new Set(ids));
    expect(p1.items[0]!.fields).toMatchObject({ '1': 'N' });

    expect((await admin.listsOf(user(A), ids[0]!, {})).items.map((l) => l.id)).toEqual([id]);
    expect(await admin.removeMembers(user(A), id, { contact_ids: [ids[0]!] })).toEqual({ changed: 1, not_found: [] });
    expect((await admin.get(user(A), id)).member_count).toBe(4);

    await expect(admin.get(user(B), id)).rejects.toMatchObject({ status: 404 });
    await expect(admin.addMembers(user(B), id, { contact_ids: ids })).rejects.toMatchObject({ status: 404 });

    await admin.remove(user(A), id);
    await expect(admin.get(user(A), id)).rejects.toMatchObject({ status: 404 });
    expect((await admin.listsOf(user(A), ids[1]!, {})).items).toEqual([]);
  });

  it('internal: adds up to 10,000 keys, idempotent, unknown keys as errors, bound to the token tenant', async () => {
    const id = await newList('Import');
    await contacts.create(user(A), { key_id: '3', contacts: [{ '3': 'imp@example.test' }] });

    const body = { tenant_id: A, key_id: '3', key_values: ['imp@example.test', 'nope@example.test'] };
    expect(await internal.add(service(A), id, body)).toEqual({ added: 1, errors: [{ index: 1, key: 'nope@example.test', code: 2008, text: expect.any(String) }] });
    expect((await internal.add(service(null), id, body)).added).toBe(0);
    await expect(internal.add(service(B), id, body)).rejects.toMatchObject({ status: 403 });
    await expect(internal.add(service(null), id, { ...body, key_values: Array(10_001).fill('a') })).rejects.toMatchObject({ status: 400 });
  });
});
