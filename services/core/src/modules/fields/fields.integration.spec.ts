import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Principal } from '@oe/ts-common/auth';
import { PublicApiError } from '@oe/ts-common/http';
import { TenantContext } from '@oe/ts-common/tenant';
import type { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PRISMA_CLIENT, PrismaModule } from '../../prisma/prisma.module.js';
import { SystemFieldsSeeder } from '../contacts-shared/system-fields.seeder.js';
import { FieldRegistry } from './field-registry.js';
import { FieldsController, PublicFieldsController } from './fields.controller.js';
import { FieldsModule } from './fields.module.js';
import { KeyResolver } from './key-resolver.js';

jest.setTimeout(180_000);

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';
const pa = { tenant_id: A } as Principal;
const label = (s: string) => ({ es: s, pt: s, en: s });

const coreDir = path.resolve(__dirname, '../../..');
const initSql = path.resolve(coreDir, '../../deploy/postgres/init/00-roles.sql');
const ROLES = ['CORE', 'IMPORTER', 'SEGMENTS', 'CONTENT', 'CAMPAIGNS', 'DISPATCHER', 'AUTOMATION', 'ML', 'ANALYTICS', 'LOYALTY', 'CONNECTORS', 'TEMPORAL'];

describe('fields (definitions, registry, key resolver)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let admin: FieldsController;
  let publicApi: PublicFieldsController;
  let registry: FieldRegistry;
  const as = <T>(tenant: string, fn: () => Promise<T>) => TenantContext.run(tenant, async () => await fn());

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:17-alpine')
      .withEnvironment(Object.fromEntries(ROLES.map((r) => [`OE_PG_${r}_PASSWORD`, r.toLowerCase()])))
      .withCopyFilesToContainer([{ source: initSql, target: '/docker-entrypoint-initdb.d/00-roles.sql' }])
      .start();
    process.env.DATABASE_URL = `postgresql://core:core@${pg.getHost()}:${pg.getPort()}/${pg.getDatabase()}?schema=identity`;
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: coreDir, env: process.env, stdio: 'inherit' });

    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, FieldsModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PRISMA_CLIENT);
    admin = moduleRef.get(FieldsController);
    publicApi = moduleRef.get(PublicFieldsController);
    registry = moduleRef.get(FieldRegistry);
    const seeder = new SystemFieldsSeeder(prisma);
    await seeder.seed(A);
    await seeder.seed(B);
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  const create = (body: Record<string, unknown>) => admin.create(pa, { labels: label('x'), ...body });

  it('creates custom fields with IDs from 1000 and keeps the ID on rename', async () => {
    const first = await create({ api_name: 'plan', type: 'text' });
    const second = await create({ api_name: 'score', type: 'number' });
    expect([first.field_id, second.field_id]).toEqual([1000, 1001]);

    const renamed = await admin.update(pa, 1000, { api_name: 'plan_name', labels: label('Plan') });
    expect(renamed).toMatchObject({ field_id: 1000, api_name: 'plan_name', labels: label('Plan') });
    const listed = (await admin.list(pa)).items.map((f) => [f.field_id, f.api_name]);
    expect(listed).toContainEqual([1000, 'plan_name']);
    expect(listed).not.toContainEqual([1000, 'plan']);

    await expect(create({ api_name: 'score', type: 'text' })).rejects.toMatchObject({ replyCode: 2015 });
    await expect(admin.create(pa, { labels: label('x'), api_name: 'Bad Name', type: 'text' })).rejects.toThrow();
    // B has its own sequence and its own names
    expect((await as(B, () => admin.create({ tenant_id: B } as Principal, { labels: label('x'), api_name: 'score', type: 'number' }))).field_id).toBe(1000);
  });

  it('only lets system fields change labels', async () => {
    await expect(admin.update(pa, 3, { api_name: 'mail' })).rejects.toThrow(/only accept labels/);
    await expect(admin.remove(pa, 3)).rejects.toThrow(/cannot be deleted/);
    expect(await admin.update(pa, 3, { labels: label('Correo') })).toMatchObject({ field_id: 3, api_name: 'email', labels: label('Correo') });
  });

  it('validates and normalizes each field type', async () => {
    const single = await create({ api_name: 'tier', type: 'single_choice', choices: [{ api_name: 'gold', labels: label('Oro') }, { api_name: 'silver', labels: label('Plata') }] });
    const multi = await create({ api_name: 'tags', type: 'multi_choice', choices: [{ api_name: 'a', labels: label('A') }, { api_name: 'b', labels: label('B') }] });
    const date = await create({ api_name: 'joined', type: 'date' });
    const flag = await create({ api_name: 'vip', type: 'boolean' });
    const num = await create({ api_name: 'spent', type: 'number' });
    expect(single.choices.map((c) => c.id)).toEqual([1, 2]);

    const v = (id: number, raw: unknown) => as(A, () => registry.validateValue(id, raw));
    expect(await v(1, 'Ana')).toEqual({ ok: true, value: 'Ana' });
    expect(await v(1, 5)).toMatchObject({ ok: false, replyCode: 2010 });
    expect(await v(num.field_id, '12.50')).toEqual({ ok: true, value: 12.5 });
    expect(await v(num.field_id, 'abc')).toMatchObject({ ok: false, replyCode: 2010 });
    expect(await v(date.field_id, '2026-02-28')).toEqual({ ok: true, value: '2026-02-28' });
    expect(await v(date.field_id, '2026-02-30')).toMatchObject({ ok: false, replyCode: 2010 });
    expect(await v(date.field_id, '28/02/2026')).toMatchObject({ ok: false, replyCode: 2010 });
    expect(await v(flag.field_id, 'true')).toEqual({ ok: true, value: true });
    expect(await v(flag.field_id, 0)).toEqual({ ok: true, value: false });
    expect(await v(flag.field_id, 'yes')).toMatchObject({ ok: false, replyCode: 2010 });
    expect(await v(single.field_id, 2)).toEqual({ ok: true, value: 2 });
    expect(await v(single.field_id, 9)).toMatchObject({ ok: false, replyCode: 2010 });
    expect(await v(multi.field_id, [1, 2, 1])).toEqual({ ok: true, value: [1, 2] });
    expect(await v(multi.field_id, [3])).toMatchObject({ ok: false, replyCode: 2010 });
    expect(await v(multi.field_id, 1)).toMatchObject({ ok: false, replyCode: 2010 });
    expect(await v(num.field_id, null)).toEqual({ ok: true, value: null });
    expect(await v(4242, 'x')).toMatchObject({ ok: false, replyCode: 2011 });

    // the registry cache is invalidated when definitions change
    const late = await create({ api_name: 'late', type: 'text' });
    expect(await v(late.field_id, 'ok')).toEqual({ ok: true, value: 'ok' });
  });

  it('serves the public API in the tenant locale', async () => {
    const created = await as(A, () =>
      publicApi.create(pa, { name: 'Fecha de Compra', application_type: 'single_choice', choices: ['Sí', 'No'] })
    );
    expect(created).toMatchObject({ name: 'Fecha de Compra', application_type: 'single_choice', string_id: 'fecha_de_compra' });
    expect(await publicApi.choices(pa, created.id)).toEqual([
      { id: 1, choice: 'Sí' },
      { id: 2, choice: 'No' },
    ]);
    expect(await publicApi.list(pa)).toContainEqual(created);
    await expect(publicApi.choices(pa, 1)).rejects.toBeInstanceOf(PublicApiError);
    await expect(publicApi.create(pa, { name: 'Fecha de Compra', application_type: 'text' })).rejects.toMatchObject({ replyCode: 2015 });
  });

  it('rejects a key_id that is not unique with 2009', async () => {
    const keys = new KeyResolver(prisma, registry);
    await create({ api_name: 'not_unique', type: 'text' });
    for (const keyId of ['1', 'id-nope', '9999', 1000]) {
      await expect(as(A, () => keys.resolve(keyId, ['x']))).rejects.toMatchObject({ replyCode: 2009 });
    }
    await expect(as(A, () => keys.resolve('3', ['nobody@example.test']))).resolves.toEqual(new Map());
  });

  it('resolves 1000 emails with a single query, plus the other key types', async () => {
    const emails = Array.from({ length: 1000 }, (_, i) => `user${i}@example.test`);
    const uniq = await create({ api_name: 'loyalty_no', type: 'text', unique: true });
    await as(A, () =>
      prisma.contact.createMany({ data: emails.map((e, i) => ({ tenantId: A, data: { '3': i === 0 ? ` ${e.toUpperCase()} ` : e, '4': `ext-${i}` } })) })
    );
    const [c0, c1] = await as(A, () => prisma.contact.findMany({ where: { externalId: { in: ['ext-0', 'ext-1'] } }, orderBy: { externalId: 'asc' } }));
    await as(A, () => prisma.uniqueValue.create({ data: { tenantId: A, fieldId: uniq.field_id, value: 'L-9', contactId: c1!.id } }));
    // another tenant's contact with the same email must not resolve
    await as(B, () => prisma.contact.create({ data: { tenantId: B, data: { '3': 'other@example.test' } } }));

    let queries = 0;
    const spy = new Proxy(prisma, {
      get: (t, p) => {
        if (p !== '$transaction') return Reflect.get(t, p);
        return (...args: unknown[]) => {
          queries++;
          return (t.$transaction as (...a: unknown[]) => unknown)(...args);
        };
      },
    });
    const keys = new KeyResolver(spy, registry);
    await as(A, () => registry.fields()); // warm the cache: definitions are not part of the count

    const found = await as(A, () => keys.resolve('3', [...emails, 'missing@example.test']));
    expect(queries).toBe(1);
    expect(found.size).toBe(1000);
    expect(found.get('user0@example.test')).toBe(c0!.id);
    expect(found.has('missing@example.test')).toBe(false);
    expect((await as(A, () => keys.resolve(3, ['other@example.test']))).size).toBe(0);

    expect([...(await as(A, () => keys.resolve('4', ['ext-1', 'ext-x']))).values()]).toEqual([c1!.id]);
    expect([...(await as(A, () => keys.resolve('id', [c0!.id, 'not-a-uuid']))).values()]).toEqual([c0!.id]);
    expect([...(await as(A, () => keys.resolve(String(uniq.field_id), ['L-9']))).values()]).toEqual([c1!.id]);
  });

  it('deletes a custom field and strips its key from contacts asynchronously', async () => {
    const f = await create({ api_name: 'temp', type: 'text' });
    const contact = await as(A, () => prisma.contact.create({ data: { tenantId: A, data: { [String(f.field_id)]: 'v', '1': 'keep' } } }));
    await admin.remove(pa, f.field_id);

    let data: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      data = (await as(A, () => prisma.contact.findUniqueOrThrow({ where: { id: contact.id } }))).data as Record<string, unknown>;
      if (!(String(f.field_id) in data)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(data).toEqual({ '1': 'keep' });
    expect((await admin.list(pa)).items.some((x) => x.field_id === f.field_id)).toBe(false);
    expect((await admin.list(pa, 'true')).items.find((x) => x.field_id === f.field_id)?.deleted_at).not.toBeNull();
    await expect(admin.remove(pa, f.field_id)).rejects.toThrow(/not found/);
    // the name is free again, the ID is not reused
    expect((await create({ api_name: 'temp', type: 'text' })).field_id).toBeGreaterThan(f.field_id);
  });
});
