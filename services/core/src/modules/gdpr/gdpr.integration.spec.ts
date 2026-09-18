import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Principal } from '@oe/ts-common/auth';
import { type EventEnvelope, NATS_CONNECTION, NatsModule } from '@oe/ts-common/nats';
import { TenantContext } from '@oe/ts-common/tenant';
import type { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NatsConnection } from 'nats';
import { Client } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { PRISMA_CLIENT, PrismaModule } from '../../prisma/prisma.module.js';
import { SystemFieldsSeeder } from '../contacts-shared/system-fields.seeder.js';
import { ContactStreamService } from '../contacts-query/contact-stream.service.js';
import { AdminContactsQueryController, PublicContactsQueryController } from '../contacts-query/contacts-query.controller.js';
import { ContactsQueryModule } from '../contacts-query/contacts-query.module.js';
import { OutboxRelay } from '../contacts-write/outbox.js';
import { ExportStorage } from './export-storage.js';
import { AdminGdprController, PublicGdprController } from './gdpr.controller.js';
import { GdprModule } from './gdpr.module.js';
import { EXPORT_TTL_S, GdprService, subjectHash } from './gdpr.service.js';

jest.setTimeout(240_000);

const A = '0192f000-0000-7000-8000-00000000000a';
const admin = { sub: '0192f000-0000-7000-8000-0000000000aa', typ: 'user', tenant_id: A, perms: ['contacts:admin'], iat: 0, exp: 0 } as Principal;

const coreDir = path.resolve(__dirname, '../../..');
const repoDir = path.resolve(coreDir, '../..');
const initSql = path.join(repoDir, 'deploy/postgres/init/00-roles.sql');
const ROLES = ['CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER', 'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL'];
const PII = /ana|garc[ií]a|ana@example\.test/i;

describe('gdpr (access export and erasure)', () => {
  let pg: StartedPostgreSqlContainer;
  let nats: StartedTestContainer;
  let minio: StartedTestContainer;
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let nc: NatsConnection;
  let gdpr: GdprService;
  let adminApi: AdminGdprController;
  let publicApi: PublicGdprController;
  let ana: string;
  let luis: string;
  let listId: string;
  let s3: S3Client;

  const as = <T>(fn: () => Promise<T>) => TenantContext.run(A, async () => await fn());
  const superuser = async <T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> => {
    const c = new Client({ connectionString: pg.getConnectionUri() });
    await c.connect();
    try {
      return (await c.query(query, params)).rows as T[];
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    [pg, nats, minio] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine')
        .withEnvironment(Object.fromEntries(ROLES.map((r) => [`OE_PG_${r}_PASSWORD`, r.toLowerCase()])))
        .withCopyFilesToContainer([{ source: initSql, target: '/docker-entrypoint-initdb.d/00-roles.sql' }])
        .start(),
      new GenericContainer('nats:2.11-alpine').withCommand(['-js']).withExposedPorts(4222).withWaitStrategy(Wait.forLogMessage(/Server is ready/)).start(),
      new GenericContainer('quay.io/minio/minio:latest')
        .withCommand(['server', '/data'])
        .withEnvironment({ MINIO_ROOT_USER: 'oe_minio', MINIO_ROOT_PASSWORD: 'oe_minio_secret' })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
        .start(),
    ]);
    process.env.DATABASE_URL = `postgresql://core:core@${pg.getHost()}:${pg.getPort()}/${pg.getDatabase()}?schema=identity`;
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: coreDir, env: process.env, stdio: 'inherit' });
    // The relational tables of F1.3.T1, until its migration reaches this branch; a no-op after.
    await superuser(`
      CREATE TABLE IF NOT EXISTS contacts.relational_tables (id uuid PRIMARY KEY DEFAULT identity.uuid_v7(), tenant_id uuid NOT NULL, name text NOT NULL,
        key_field text NOT NULL, columns jsonb NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS contacts.relational_rows (table_id uuid NOT NULL REFERENCES contacts.relational_tables ON DELETE CASCADE, contact_id uuid NOT NULL,
        key text NOT NULL, tenant_id uuid NOT NULL, data jsonb NOT NULL, updated_at timestamptz(3) NOT NULL DEFAULT now(), PRIMARY KEY (table_id, contact_id, key));
      ALTER TABLE contacts.relational_tables OWNER TO core;
      ALTER TABLE contacts.relational_rows OWNER TO core;`);

    const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    Object.assign(process.env, { CORE_MINIO_ENDPOINT: endpoint, CORE_MINIO_ACCESS_KEY: 'oe_minio', CORE_MINIO_SECRET_KEY: 'oe_minio_secret' });
    s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'oe_minio', secretAccessKey: 'oe_minio_secret' } });
    await s3.send(new CreateBucketCommand({ Bucket: 'exports' }));

    // Not `init()`ed: the outbox relay stays off and the test drains it.
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, NatsModule.forRoot({ servers: `${nats.getHost()}:${nats.getMappedPort(4222)}`, source: 'core' }), GdprModule, ContactsQueryModule],
    }).compile();
    prisma = moduleRef.get(PRISMA_CLIENT);
    nc = moduleRef.get(NATS_CONNECTION);
    gdpr = moduleRef.get(GdprService);
    adminApi = moduleRef.get(AdminGdprController);
    publicApi = moduleRef.get(PublicGdprController);
    await (await nc.jetstreamManager()).streams.add(JSON.parse(readFileSync(path.join(repoDir, 'deploy/nats/streams/CONTACTS.json'), 'utf8')));
    await new SystemFieldsSeeder(prisma).seed(A);

    // Ana has something in every table the erasure touches; Luis is the control.
    ana = (await as(() => prisma.contact.create({ data: { tenantId: A, data: { '1': 'Ana', '2': 'García', '3': 'ana@example.test' } } }))).id;
    luis = (await as(() => prisma.contact.create({ data: { tenantId: A, data: { '1': 'Luis', '3': 'luis@example.test' } } }))).id;
    listId = (await as(() => prisma.contactList.create({ data: { tenantId: A, name: 'newsletter' } }))).id;
    const [table] = await superuser<{ id: string }>(`INSERT INTO contacts.relational_tables (tenant_id, name, key_field, columns)
      VALUES ($1, 'mascotas', 'nombre', '[{"name":"nombre","type":"text"}]') RETURNING id::text`, [A]);
    const seed: [string, unknown[]][] = [
      ['INSERT INTO contacts.list_members (list_id, contact_id, tenant_id) VALUES ($1, $2, $3), ($1, $4, $3)', [listId, ana, A, luis]],
      [`INSERT INTO contacts.unique_values (tenant_id, field_id, value, contact_id) VALUES ($1, 1000, 'socio-17', $2)`, [A, ana]],
      [`INSERT INTO contacts.identity_links (tenant_id, anonymous_id, contact_id) VALUES ($1, 'anon-ana', $2)`, [A, ana]],
      [`INSERT INTO contacts.relational_rows (table_id, contact_id, key, tenant_id, data) VALUES ($1, $2, 'rex', $3, '{"nombre":"Rex"}')`, [table!.id, ana, A]],
      [
        `INSERT INTO contacts.consents (tenant_id, contact_id, channel, value, source, text, changed_at) VALUES
          ($1, $2, 'email', 1, 'signup_form', 'Yo, Ana García (ana@example.test), acepto recibir emails', '2026-01-02T03:04:05Z'),
          ($1, $2, 'email', 2, 'preference_center', 'Ana se da de baja', '2026-03-04T05:06:07Z'),
          ($1, $3, 'email', 1, 'signup_form', 'Luis acepta', '2026-01-02T03:04:05Z')`,
        [A, ana, luis],
      ],
      [
        `INSERT INTO identity.audit_log (tenant_id, actor_type, actor_id, action, resource_type, resource_id, diff)
          VALUES ($1, 'user', 'u1', 'PATCH', 'contacts', $2, '{"1":"Ana"}')`,
        [A, ana],
      ],
    ];
    for (const [q, params] of seed) await superuser(q, params);
  });

  afterAll(async () => {
    await moduleRef?.close();
    await Promise.all([nats?.stop(), minio?.stop(), pg?.stop()]);
  });

  it('exports profile with labels, consents, lists, relational rows and audit to a URL that expires in 24 h', async () => {
    const accepted = await adminApi.export(admin, ana);
    expect(accepted).toMatchObject({ kind: 'export', status: 'pending', contact_id: ana, result_url: null });
    await gdpr.idle();

    const { items } = await adminApi.list(admin, 'export');
    const done = items.find((r) => r.id === accepted.id)!;
    expect(done.status).toBe('done');
    expect(Date.parse(done.result_expires_at!) - Date.parse(done.completed_at!)).toBe(EXPORT_TTL_S * 1000);
    expect(new URL(done.result_url!).searchParams.get('X-Amz-Expires')).toBe('86400');

    const res = await fetch(done.result_url!);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, any>;
    expect(doc.profile.id).toBe(ana);
    expect(doc.profile.fields).toContainEqual({ field_id: 3, api_name: expect.any(String), labels: expect.objectContaining({ es: expect.any(String) }), value: 'ana@example.test' });
    expect(doc.consents.map((c: any) => [c.value, c.source])).toEqual([[1, 'signup_form'], [2, 'preference_center']]);
    expect(doc.lists).toEqual([expect.objectContaining({ id: listId, name: 'newsletter' })]);
    expect(doc.relational).toEqual([expect.objectContaining({ table_name: 'mascotas', key: 'rex', data: { nombre: 'Rex' } })]);
    expect(doc.audit).toEqual([expect.objectContaining({ action: 'PATCH', resource_type: 'contacts', diff: { '1': 'Ana' } })]);

    // The same object signed 24 h and a minute ago is refused: the link expires.
    const stale = moduleRef.get(ExportStorage).presignGet(`gdpr/${A}/${accepted.id}.json`, new Date(Date.now() - (EXPORT_TTL_S + 60) * 1000), EXPORT_TTL_S);
    expect((await fetch(stale)).status).toBe(403);
  });

  it('forgets the contact everywhere, anonymizes consents and publishes contacts.deleted with reason gdpr', async () => {
    const before = await superuser<{ id: string; value: number; changed_at: Date }>(
      `SELECT id::text, value, changed_at FROM contacts.consents WHERE contact_id = $1 ORDER BY changed_at`, [ana]);
    const { job_id } = await publicApi.forget(admin, { key_id: '3', key_value: 'ANA@example.test' });
    await gdpr.idle();

    // Rows are gone physically, not soft-deleted.
    for (const [table, col] of [['contacts', 'id'], ['unique_values', 'contact_id'], ['list_members', 'contact_id'], ['relational_rows', 'contact_id'], ['identity_links', 'contact_id']]) {
      expect(await superuser(`SELECT 1 FROM contacts.${table} WHERE ${col} = $1`, [ana])).toEqual([]);
    }

    // Search, getdata, list members and the stream no longer return her; Luis is untouched.
    const search = moduleRef.get(AdminContactsQueryController);
    expect((await search.search(admin, 'ana')).items).toEqual([]);
    expect((await search.search(admin, 'luis')).items).toHaveLength(1);
    const getdata = await moduleRef.get(PublicContactsQueryController).getData(admin, { keyId: '3', keyValues: ['ana@example.test'], fields: ['1', '3'] });
    expect(getdata.result).toEqual([]);
    expect(getdata.errors).toEqual([expect.objectContaining({ code: 2008 })]);
    const streamed = async (list?: string) => {
      const out = new PassThrough();
      const chunks: Buffer[] = [];
      out.on('data', (c: Buffer) => chunks.push(c));
      await moduleRef.get(ContactStreamService).stream(A, [1, 3], list, out);
      return Buffer.concat(chunks).toString();
    };
    for (const text of [await streamed(), await streamed(listId)]) {
      expect(text).toContain('luis@example.test');
      expect(text).not.toMatch(PII);
      expect(text).not.toContain(ana);
    }

    // Consent history stays as proof (date, value, source) without personal data.
    const after = await superuser<{ id: string; value: number; changed_at: Date; text: string | null }>(
      `SELECT id::text, value, changed_at, text FROM contacts.consents WHERE contact_id = $1 ORDER BY changed_at`, [ana]);
    expect(after.map(({ text: _, ...r }) => r)).toEqual(before);
    expect(after.every((c) => c.text === null)).toBe(true);
    expect(JSON.stringify(after)).not.toMatch(PII);
    expect((await superuser<{ text: string }>(`SELECT text FROM contacts.consents WHERE contact_id = $1`, [luis]))[0]!.text).toBe('Luis acepta');

    // The request keeps a hash of the ID, never the email; earlier exports are unlinked and deleted.
    const requests = await superuser(`SELECT * FROM contacts.gdpr_requests`);
    expect(JSON.stringify(requests)).not.toMatch(PII);
    expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ id: job_id, kind: 'forget', status: 'done', contact_id: null, subject_hash: subjectHash(ana) })]));
    expect(requests.every((r) => r.contact_id === null && r.result_key === null)).toBe(true);
    expect((await s3.send(new ListObjectsV2Command({ Bucket: 'exports' }))).KeyCount).toBe(0);

    // contacts.deleted with reason gdpr went out through the outbox.
    const relay = moduleRef.get(OutboxRelay);
    while ((await relay.drain()) > 0);
    const consumer = await nc.jetstream().consumers.get('CONTACTS');
    const events: EventEnvelope[] = [];
    for await (const m of await consumer.fetch({ max_messages: 10, expires: 2_000 })) events.push(m.json<EventEnvelope>());
    expect(events).toEqual([expect.objectContaining({ type: 'contacts.deleted', tenant_id: A, contact_id: ana, data: { reason: 'gdpr' } })]);

    // Asking again for the same person is 2008 now.
    await expect(publicApi.export(admin, { key_id: '3', key_value: 'ana@example.test' })).rejects.toMatchObject({ replyCode: 2008 });
  });
});
