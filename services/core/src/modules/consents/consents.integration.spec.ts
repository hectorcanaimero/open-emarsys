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
import { OutboxRelay } from '../contacts-write/outbox.js';
import { AdminConsentsController, PublicConsentsController } from './consents.controller.js';
import { ConsentsModule } from './consents.module.js';
import { ConsentsService } from './consents.service.js';

jest.setTimeout(180_000);

const A = '0192f000-0000-7000-8000-00000000000a';
const user = { sub: 'u1', typ: 'user', tenant_id: A, perms: ['contacts:edit', 'contacts:view'], iat: 0, exp: 0 } as Principal;

const coreDir = path.resolve(__dirname, '../../..');
const repoDir = path.resolve(coreDir, '../..');
const initSql = path.join(repoDir, 'deploy/postgres/init/00-roles.sql');
const ROLES = ['CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER', 'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL'];

describe('consents (history, current value, events)', () => {
  let pg: StartedPostgreSqlContainer;
  let nats: StartedTestContainer;
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let nc: NatsConnection;
  let relay: OutboxRelay;
  let publicConsent: PublicConsentsController;
  let admin: AdminConsentsController;
  let contacts: PublicContactsWriteController;

  const as = <T>(fn: () => Promise<T>) => TenantContext.run(A, async () => await fn());
  const fieldsOf = async (id: string) => (await as(() => prisma.contact.findFirstOrThrow({ where: { id } }))).data as Record<string, unknown>;
  const consentEvents = async (contactId: string) => {
    while ((await relay.drain()) > 0);
    const jsm = await nc.jetstreamManager();
    const total = (await jsm.streams.info('CONTACTS')).state.messages;
    const out: EventEnvelope<{ channel: string; value: number | null; source: string; text: string | null }>[] = [];
    const consumer = await nc.jetstream().consumers.get('CONTACTS');
    for await (const m of await consumer.fetch({ max_messages: total, expires: 5_000 })) {
      const e = m.json<EventEnvelope<{ channel: string; value: number | null; source: string; text: string | null }>>();
      if (e.type === 'consent.changed' && e.contact_id === contactId) out.push(e);
      if (m.info.pending === 0) break;
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

    // Not `init()`ed: the relay's timer stays off; `consentEvents` drains by hand.
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, NatsModule.forRoot({ servers: `${nats.getHost()}:${nats.getMappedPort(4222)}`, source: 'core' }), ConsentsModule],
    }).compile();
    await moduleRef.get(ConsentsService).onModuleInit();
    prisma = moduleRef.get(PRISMA_CLIENT);
    nc = moduleRef.get(NATS_CONNECTION);
    relay = moduleRef.get(OutboxRelay);
    publicConsent = moduleRef.get(PublicConsentsController);
    admin = moduleRef.get(AdminConsentsController);
    contacts = moduleRef.get(PublicContactsWriteController);

    const jsm = await nc.jetstreamManager();
    await jsm.streams.add(JSON.parse(readFileSync(path.join(repoDir, 'deploy/nats/streams/CONTACTS.json'), 'utf8')));
    await new SystemFieldsSeeder(prisma).seed(A);
  });

  afterAll(async () => {
    await moduleRef?.close();
    await nats?.stop();
    await pg?.stop();
  });

  it('records three email opt-in changes with source and text, and field 31 holds the last', async () => {
    const [id] = (await contacts.create(user, { key_id: '3', contacts: [{ '3': 'ana@example.test' }] })).ids as [string];
    const changes = [
      { value: 1, source: 'signup_form', text: 'Acepto recibir novedades.' },
      { value: 2, source: 'unsubscribe', text: 'Baja desde el enlace.' },
      { value: 1, source: 'preference_center', text: 'Vuelvo a aceptar.' },
    ];
    for (const c of changes) {
      await publicConsent.set(user, { key_id: '3', key_value: 'ana@example.test', channel: 'email', ...c });
    }

    const { items } = await admin.list(user, id, { channel: 'email' });
    expect(items.map((i) => [i.value, i.source, i.text])).toEqual(changes.map((c) => [c.value, c.source, c.text]).reverse());
    expect(items[0]).toMatchObject({ actor_type: 'user', actor_id: 'u1' });
    expect((await fieldsOf(id))['31']).toBe(1);

    const events = await consentEvents(id);
    expect(events.map((e) => e.data)).toEqual(changes.map((c) => ({ channel: 'email', ...c })));
  });

  it('records a direct write of field 31 through PUT /contact with source api', async () => {
    const [id] = (await contacts.create(user, { key_id: '3', contacts: [{ '3': 'bea@example.test' }] })).ids as [string];
    await contacts.update(user, { key_id: '3', contacts: [{ '3': 'bea@example.test', '31': 2 }] });

    const { items } = await admin.list(user, id, {});
    expect(items).toMatchObject([{ channel: 'email', value: 2, source: 'api', text: null }]);
    expect((await fieldsOf(id))['31']).toBe(2);
    expect((await consentEvents(id)).map((e) => e.data)).toEqual([{ channel: 'email', value: 2, source: 'api', text: null }]);
  });

  it('records the admin endpoint and keeps channels apart', async () => {
    const [id] = (await contacts.create(user, { key_id: '3', contacts: [{ '3': 'cy@example.test' }] })).ids as [string];
    const row = await admin.record(user, id, { channel: 'sms', value: 1, source: 'admin', text: 'ok' });
    expect(row).toMatchObject({ channel: 'sms', value: 1, source: 'admin', text: 'ok' });
    expect((await fieldsOf(id))['32']).toBe(1);
    expect((await admin.list(user, id, { channel: 'email' })).items).toEqual([]);
    await expect(admin.record(user, '0192f000-0000-7000-8000-0000000000ff', { channel: 'sms', value: 1, source: 'admin' })).rejects.toMatchObject({ status: 404 });
  });
});
