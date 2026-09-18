import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Generated, Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantContext } from '../tenant/index.js';
import { createKysely, withSystemScope, withTenantScope } from './index.js';

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';
const B1 = '0192f000-0000-7000-8000-0000000000b1';

const pkgDir = fileURLToPath(new URL('../..', import.meta.url));
const schema = fileURLToPath(new URL('./testdata/schema.prisma', import.meta.url));
const clientDir = fileURLToPath(new URL('../../node_modules/.prisma-tenant-test', import.meta.url));

// The app connects as a non-superuser: RLS never applies to superusers.
const SETUP = `
  create role app login password 'app';
  create role ops nologin bypassrls;
  grant ops to app;
  create table items (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    name text not null
  );
  alter table items enable row level security;
  alter table items force row level security;
  create policy tenant_isolation on items
    using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
  grant select, insert, update, delete on items to app, ops;
`;

interface DB {
  items: { id: Generated<string>; tenant_id: string; name: string };
}
interface Item {
  id: string;
  tenantId: string;
  name: string;
}

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let pool: pg.Pool;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let base: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let kysely: Kysely<DB>;

const asA = <T>(fn: () => T) => TenantContext.run(A, fn);
const tenantBRows = async () =>
  (await admin.query('select name from items where tenant_id = $1', [B])).rows.map((r) => r.name);

beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'prisma', 'generate', '--schema', schema], { cwd: pkgDir, stdio: 'inherit' });
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(SETUP);

  const url = `postgresql://app:app@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  const { PrismaClient } = createRequire(import.meta.url)(clientDir);
  base = new PrismaClient({ datasourceUrl: url });
  prisma = withTenantScope(base, { systemRole: 'ops' });
  pool = new pg.Pool({ connectionString: url });
  kysely = createKysely<DB>(pool, { systemRole: 'ops' });
}, 180_000);

afterAll(async () => {
  await kysely?.destroy();
  await base?.$disconnect();
  await admin?.end();
  await container?.stop();
});

beforeEach(async () => {
  await admin.query('truncate items');
  await admin.query("insert into items (tenant_id, name) values ($1, 'a1')", [A]);
  await admin.query("insert into items (id, tenant_id, name) values ($1, $2, 'b1')", [B1, B]);
});

describe('prisma', () => {
  it('reads only the current tenant', async () => {
    const rows: Item[] = await asA(() => prisma.item.findMany());
    expect(rows.map((r) => r.name)).toEqual(['a1']);
    expect(await asA(() => prisma.item.findUnique({ where: { id: B1 } }))).toBeNull();
  });

  it('cannot update, delete or insert rows of another tenant', async () => {
    expect(await asA(() => prisma.item.updateMany({ data: { name: 'x' } }))).toEqual({ count: 1 });
    await expect(asA(() => prisma.item.update({ where: { id: B1 }, data: { name: 'x' } }))).rejects.toThrow();
    expect(await asA(() => prisma.item.deleteMany({ where: { id: B1 } }))).toEqual({ count: 0 });
    await expect(asA(() => prisma.item.delete({ where: { id: B1 } }))).rejects.toThrow();
    await expect(asA(() => prisma.item.create({ data: { tenantId: B, name: 'b2' } }))).rejects.toThrow();
    expect(await tenantBRows()).toEqual(['b1']);
  });

  it('throws without a tenant in context', async () => {
    await expect(prisma.item.findMany()).rejects.toThrow(/no tenant in context/);
    await expect(prisma.$transaction(async () => 1)).rejects.toThrow(/no tenant in context/);
  });

  it('keeps the tenant for operations nested in $transaction', async () => {
    const rows: Item[] = await asA(() =>
      prisma.$transaction(async (tx: typeof prisma) => {
        await tx.item.create({ data: { tenantId: A, name: 'a2' } });
        await tx.item.updateMany({ data: { name: 'y' } });
        return tx.item.findMany();
      })
    );
    expect(rows.map((r) => [r.tenantId, r.name])).toEqual([
      [A, 'y'],
      [A, 'y'],
    ]);
    expect(await tenantBRows()).toEqual(['b1']);
  });

  it('runs nested operations inside the same transaction', async () => {
    await expect(
      asA(() =>
        prisma.$transaction(async (tx: typeof prisma) => {
          await tx.item.create({ data: { tenantId: A, name: 'rolled-back' } });
          throw new Error('boom');
        })
      )
    ).rejects.toThrow('boom');
    expect((await admin.query("select 1 from items where name = 'rolled-back'")).rowCount).toBe(0);
  });

  it('keeps the tenant in batch $transaction', async () => {
    const [rows, count] = await asA(() =>
      prisma.$transaction([prisma.item.findMany(), prisma.item.count()])
    );
    expect([rows.length, count]).toEqual([1, 1]);
  });

  it('sees every tenant under withSystemScope with a BYPASSRLS role', async () => {
    expect(await withSystemScope(() => prisma.item.count())).toBe(2);
  });
});

describe('kysely', () => {
  it('reads only the current tenant', async () => {
    const rows = await asA(() => kysely.selectFrom('items').select('name').execute());
    expect(rows).toEqual([{ name: 'a1' }]);
  });

  it('cannot update, delete or insert rows of another tenant', async () => {
    const updated = await asA(() => kysely.updateTable('items').set({ name: 'x' }).executeTakeFirst());
    expect(updated.numUpdatedRows).toBe(1n);
    const deleted = await asA(() => kysely.deleteFrom('items').where('id', '=', B1).executeTakeFirst());
    expect(deleted.numDeletedRows).toBe(0n);
    await expect(
      asA(() => kysely.insertInto('items').values({ tenant_id: B, name: 'b2' }).execute())
    ).rejects.toThrow(/row-level security/);
    expect(await tenantBRows()).toEqual(['b1']);
  });

  it('throws without a tenant in context', async () => {
    await expect(kysely.selectFrom('items').selectAll().execute()).rejects.toThrow(/no tenant in context/);
    await expect(kysely.transaction().execute(async () => 1)).rejects.toThrow(/no tenant in context/);
  });

  it('keeps the tenant inside db.transaction()', async () => {
    const rows = await asA(() =>
      kysely.transaction().execute(async (trx) => {
        await trx.insertInto('items').values({ tenant_id: A, name: 'a2' }).execute();
        return trx.selectFrom('items').select('tenant_id').execute();
      })
    );
    expect(rows).toEqual([{ tenant_id: A }, { tenant_id: A }]);
  });

  it('sees every tenant under withSystemScope with a BYPASSRLS role', async () => {
    const rows = await withSystemScope(() => kysely.selectFrom('items').select('id').execute());
    expect(rows).toHaveLength(2);
  });
});
