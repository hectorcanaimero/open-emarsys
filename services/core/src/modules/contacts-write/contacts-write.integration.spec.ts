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
import { SYSTEM_PRISMA_CLIENT } from '../tenants/system-prisma.module.js';
import { AdminContactsWriteController, InternalContactsWriteController, PublicContactsWriteController } from './contacts-write.controller.js';
import { ContactsWriteModule } from './contacts-write.module.js';
import { OutboxRelay } from './outbox.js';

jest.setTimeout(180_000);

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';
const user = (tenant: string) => ({ sub: 'u', typ: 'user', tenant_id: tenant, perms: ['contacts:edit'], iat: 0, exp: 0 }) as Principal;
const service = (tenant: string | null) => ({ sub: 'importer', typ: 'service', tenant_id: tenant, scopes: ['contacts:edit'], iat: 0, exp: 0 }) as Principal;

const coreDir = path.resolve(__dirname, '../../..');
const repoDir = path.resolve(coreDir, '../..');
const initSql = path.join(repoDir, 'deploy/postgres/init/00-roles.sql');
const ROLES = ['CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER', 'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL'];

type Upserted = EventEnvelope<{ version: number; fields: Record<string, unknown>; changed: string[]; lists: string[] }>;

describe('contacts-write (batch engine, outbox, events)', () => {
  let pg: StartedPostgreSqlContainer;
  let nats: StartedTestContainer;
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let nc: NatsConnection;
  let api: PublicContactsWriteController;
  let admin: AdminContactsWriteController;
  let internal: InternalContactsWriteController;
  let relay: OutboxRelay;

  const as = <T>(tenant: string, fn: () => Promise<T>) => TenantContext.run(tenant, async () => await fn());
  const contactBy = (tenant: string, email: string) => as(tenant, () => prisma.contact.findFirstOrThrow({ where: { emailNorm: email } }));
  const outboxSize = () => as(A, () => prisma.contactsOutbox.count());

  /** Publishes everything pending, as the running relay would. */
  const drain = async (r = relay) => {
    while ((await r.drain()) > 0);
  };

  /** Every envelope in the CONTACTS stream, in order. */
  async function streamed(): Promise<EventEnvelope[]> {
    const jsm = await nc.jetstreamManager();
    const total = (await jsm.streams.info('CONTACTS')).state.messages;
    const out: EventEnvelope[] = [];
    if (total === 0) return out;
    const consumer = await nc.jetstream().consumers.get('CONTACTS');
    for await (const m of await consumer.fetch({ max_messages: total, expires: 5_000 })) {
      out.push(m.json<EventEnvelope>());
      if (out.length === total) break;
    }
    return out;
  }
  const eventsOf = async (contactId: string) => (await streamed()).filter((e) => e.contact_id === contactId);

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

    // Not `init()`ed: the relay's timer stays off and each test drains when it wants to.
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, NatsModule.forRoot({ servers: `${nats.getHost()}:${nats.getMappedPort(4222)}`, source: 'core' }), ContactsWriteModule],
    }).compile();
    prisma = moduleRef.get(PRISMA_CLIENT);
    nc = moduleRef.get(NATS_CONNECTION);
    api = moduleRef.get(PublicContactsWriteController);
    admin = moduleRef.get(AdminContactsWriteController);
    internal = moduleRef.get(InternalContactsWriteController);
    relay = moduleRef.get(OutboxRelay);

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

  it('writes 998 valid contacts of a 1,000 batch and reports the 2 invalid ones by position', async () => {
    const contacts: Record<string, unknown>[] = Array.from({ length: 1000 }, (_, i) => ({ '3': `bulk${i}@example.test`, '1': `N${i}` }));
    contacts[10] = { '3': 'bad-date@example.test', '6': '1990-02-31' };
    contacts[500] = { '3': 'bad-field@example.test', '9999': 'x' };

    const res = await api.create(user(A), { key_id: '3', contacts });

    expect(res.ids).toHaveLength(998);
    expect(res.errors).toEqual([
      { index: 10, key: 'bad-date@example.test', code: 2010, text: expect.any(String) },
      { index: 500, key: 'bad-field@example.test', code: 2011, text: expect.any(String) },
    ]);
    expect(await as(A, () => prisma.contact.count({ where: { emailNorm: { startsWith: 'bulk' } } }))).toBe(998);
    expect(await as(A, () => prisma.contact.count({ where: { emailNorm: { startsWith: 'bad-' } } }))).toBe(0);

    await drain();
    const upserted = (await streamed()).filter((e) => e.type === 'contacts.upserted');
    expect(upserted).toHaveLength(998);
    expect(new Set(upserted.map((e) => e.contact_id))).toEqual(new Set(res.ids));
    expect(upserted[0]).toMatchObject({ source: 'core', tenant_id: A, data: { version: 1, changed: expect.arrayContaining(['1', '3']), lists: [] } });
  });

  it('rejects batches over 1,000 and a non-unique key_id as a whole', async () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ '3': `x${i}@example.test` }));
    await expect(api.create(user(A), { key_id: '3', contacts: tooMany })).rejects.toMatchObject({ replyCode: 1002 });
    await expect(api.create(user(A), { key_id: '1', contacts: [{ '1': 'Ana' }] })).rejects.toMatchObject({ replyCode: 2009 });
  });

  it('updates only the sent keys, bumps version, and null removes a key', async () => {
    const [id] = (await api.create(user(A), { key_id: '3', contacts: [{ '3': 'ana@example.test', '1': 'Ana', '2': 'Pérez', '5': '+5491100000000' }] })).ids;

    const res = await api.update(user(A), { key_id: '3', contacts: [{ '3': 'ana@example.test', '1': 'Anita', '5': null }] });
    expect(res).toEqual({ ids: [id], errors: [] });
    const after = await contactBy(A, 'ana@example.test');
    expect(after.data).toEqual({ '3': 'ana@example.test', '1': 'Anita', '2': 'Pérez' });
    expect(after.version).toBe(2n);

    // Same values again: nothing changes, no version bump, no event.
    await api.update(user(A), { key_id: '3', contacts: [{ '3': 'ana@example.test', '1': 'Anita' }] });
    expect((await contactBy(A, 'ana@example.test')).version).toBe(2n);

    await drain();
    const events = (await eventsOf(id!)) as Upserted[];
    expect(events.map((e) => [e.data.version, e.data.changed])).toEqual([
      [1, expect.arrayContaining(['1', '2', '3', '5'])],
      [2, ['1', '5']],
    ]);
    expect(events[1]!.data.fields).toMatchObject({ '1': 'Anita', '2': 'Pérez', '3': 'ana@example.test', '40': after.createdAt.toISOString() });
    expect(events[1]!.data.fields).not.toHaveProperty('5');
  });

  it('applies per-item rules: read-only, missing keys, existing contacts, taken unique values', async () => {
    await api.create(user(A), { key_id: '3', contacts: [{ '3': 'taken@example.test', '4': 'ext-taken' }] });
    const res = await api.update(user(A), {
      key_id: '3',
      contacts: [
        { '3': 'taken@example.test', '40': '2020-01-01' },
        { '1': 'no key' },
        { '3': 'nobody@example.test', '1': 'x' },
        { '3': 'ana@example.test', '4': 'ext-taken' },
        { '3': 'new1@example.test', '4': 'ext-dup' },
        { '3': 'new2@example.test', '4': 'ext-dup' },
      ],
    });
    expect(res.errors.map((e) => [e.index, e.code])).toEqual([
      [0, 2013],
      [1, 2014],
      [2, 2008],
      [3, 2012],
      [4, 2008],
      [5, 2008],
    ]);
    expect(res.ids).toEqual([]);

    const upsert = await api.update(user(A), { key_id: '3', contacts: [{ '3': 'new1@example.test', '4': 'ext-dup' }, { '3': 'new2@example.test', '4': 'ext-dup' }] }, '1');
    expect(upsert.ids).toHaveLength(1);
    expect(upsert.errors.map((e) => [e.index, e.code])).toEqual([[1, 2014]]);
    expect((await api.create(user(A), { key_id: '3', contacts: [{ '3': 'NEW1@example.test ' }] })).errors[0]?.code).toBe(2012);
  });

  it('publishes exactly one contacts.upserted per write even if the relay dies between publish and delete', async () => {
    await drain();
    const [id] = (await api.create(user(A), { key_id: '3', contacts: [{ '3': 'crash@example.test' }] })).ids;
    expect(await outboxSize()).toBe(1);

    // First relay publishes, then "crashes" before its delete commits.
    const doomed = new OutboxRelay(moduleRef.get(SYSTEM_PRISMA_CLIENT), nc);
    const send = doomed.send.bind(doomed);
    jest.spyOn(doomed, 'send').mockImplementation(async (row) => {
      await send(row);
      throw new Error('process killed');
    });
    await expect(doomed.drain()).rejects.toThrow('process killed');
    expect(await outboxSize()).toBe(1);
    expect(await eventsOf(id!)).toHaveLength(1);

    // A restarted relay publishes the row again; JetStream drops the duplicate.
    await drain(new OutboxRelay(moduleRef.get(SYSTEM_PRISMA_CLIENT), nc));
    expect(await outboxSize()).toBe(0);
    const events = await eventsOf(id!);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'contacts.upserted', contact_id: id });
  });

  it('does not let tenant A write or delete a contact of tenant B by ID', async () => {
    const [bId] = (await api.create(user(B), { key_id: '3', contacts: [{ '3': 'bee@example.test', '1': 'Bee' }] })).ids;

    const res = await api.update(user(A), { key_id: 'id', contacts: [{ id: bId, '1': 'hacked' }] });
    expect(res).toEqual({ ids: [], errors: [{ index: 0, key: bId, code: 2008, text: expect.any(String) }] });
    await expect(admin.update(user(A), bId!, { fields: { '1': 'hacked' } })).rejects.toThrow(/not found/);
    await expect(admin.remove(user(A), bId!)).rejects.toThrow(/not found/);
    await expect(internal.setFields(service(A), bId!, { tenant_id: A, fields: { '1': 'hacked' } })).rejects.toThrow(/not found/);
    await expect(internal.batchUpsert(service(A), { tenant_id: B, key_id: 'id', mode: 'update', contacts: [{ id: bId, '1': 'hacked' }] })).rejects.toThrow(/does not match/);

    const b = await contactBy(B, 'bee@example.test');
    expect(b.data).toEqual({ '3': 'bee@example.test', '1': 'Bee' });
    expect(b.version).toBe(1n);
  });

  it('serves admin and internal writes with the same engine', async () => {
    const { id } = await contactBy(A, 'ana@example.test');
    expect(await admin.update(user(A), id, { fields: { '2': null, '9': 'AR' } })).toMatchObject({ id, version: 3, fields: { '1': 'Anita', '3': 'ana@example.test', '9': 'AR' } });
    await expect(admin.update(user(A), id, { fields: { '41': '2020-01-01' } })).rejects.toThrow();

    expect(await internal.setFields(service(null), id, { tenant_id: A, fields: { '8': 'Rosario' } })).toEqual({ id, version: 4, changed: ['8'] });
    const batch = await internal.batchUpsert(service(null), {
      tenant_id: A,
      key_id: '3',
      mode: 'upsert',
      contacts: [{ '3': 'ana@example.test', '1': 'Ana' }, { '3': 'imported@example.test' }, { '3': 'broken@example.test', '7': 99 }],
    });
    expect(batch.results).toEqual([
      { index: 0, id, created: false },
      { index: 1, id: expect.any(String), created: true },
      { index: 2, id: null, created: false, error: { code: 2010, text: expect.any(String), field_id: '7' } },
    ]);
  });

  it('soft-deletes by key and by ID, frees the email and publishes contacts.deleted', async () => {
    const [id1, id2] = (await api.create(user(A), { key_id: '3', contacts: [{ '3': 'gone1@example.test' }, { '3': 'gone2@example.test' }] })).ids;

    const res = await api.remove(user(A), { key_id: '3', contacts: [{ '3': 'gone1@example.test' }, { '3': 'never@example.test' }] });
    expect(res).toEqual({ ids: [id1], errors: [{ index: 1, key: 'never@example.test', code: 2008, text: expect.any(String) }] });
    await admin.remove(user(A), id2!);
    await expect(admin.remove(user(A), id2!)).rejects.toThrow(/not found/);

    const rows = await as(A, () => prisma.contact.findMany({ where: { id: { in: [id1!, id2!] } } }));
    expect(rows.every((r) => r.deletedAt !== null)).toBe(true);
    expect((await api.create(user(A), { key_id: '3', contacts: [{ '3': 'gone1@example.test' }] })).ids).toHaveLength(1);

    await drain();
    for (const id of [id1, id2]) {
      expect((await eventsOf(id!)).filter((e) => e.type === 'contacts.deleted').map((e) => e.data)).toEqual([{ reason: 'api' }]);
    }
  });
});
