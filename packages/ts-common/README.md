# @oe/ts-common

Shared code for the NestJS services: `config`, `otel`, `http`, `auth`, `tenant`, `prisma-tenant`, `nats`, `audit`.

## Tenant context and RLS (`tenant`, `prisma-tenant`)

Every business table is isolated per tenant by PostgreSQL row-level security (NFR-8). The
application never filters by `tenant_id` for security; it sets `app.tenant_id` on the
transaction and the policy does the rest.

### Tenant context

- `TenantInterceptor` sets the tenant from the principal (`request.user.tenant_id`) on HTTP and
  from the envelope `tenant_id` on RPC handlers. Register it globally after the auth guard.
- NATS consumers wrap their handler: `TenantContext.run(envelope.tenant_id, () => handle(envelope))`.
- `requireTenant()` returns the current tenant or throws `MissingTenantError`.

### Prisma

```ts
const prisma = withTenantScope(new PrismaClient(), { systemRole: 'core_ops' });

await prisma.contact.findMany();                 // own transaction + set_config('app.tenant_id', …, true)
await prisma.$transaction(async (tx) => {        // tenant set once, every tx.* op reuses it
  await tx.contact.update(/* … */);
  await tx.$queryRaw`…`;                         // raw SQL is scoped only on tx
});
await withSystemScope(() => prisma.tenant.findMany()); // operator only (SET LOCAL ROLE core_ops)
```

Any model operation without a tenant in context throws before touching the database. Inside a
`$transaction` callback always use `tx`: the outer client does not share the transaction and
sees no rows. `prisma.$queryRaw` outside a transaction is not scoped.

### Kysely (D8)

```ts
const db = createKysely<DB>(pool, { systemRole: 'core_ops' });
```

Queries outside `db.transaction()` run in their own `begin; set_config(…); query; commit`;
`db.transaction()` sets the tenant once after `BEGIN`. `streamQuery` only works inside a
transaction.

### Standard RLS policy

Every table with `tenant_id` gets this in its migration (manual SQL in the Prisma migration):

```sql
alter table contacts.contacts enable row level security;
alter table contacts.contacts force row level security;
create policy tenant_isolation on contacts.contacts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

- `current_setting(…, true)` returns null instead of failing when the variable was never set,
  and `nullif(…, '')` covers connections where a previous transaction set it (it resets to
  `''`, which does not cast to uuid). Either way the policy matches no row: it fails closed.
- `with check` stops inserting or moving rows into another tenant.
- `force row level security` applies the policy to the table owner too. Superusers and roles
  with `BYPASSRLS` always skip RLS, so the service must connect as a plain role.
- Child tables without their own `tenant_id` (e.g. `list_members`) use a policy that joins
  their parent: `using (exists (select 1 from contacts.lists l where l.id = list_id))`. The
  parent's own policy filters it.

### Operator access (`withSystemScope`)

Only for platform operator paths (e.g. core's tenants module). If the service sets
`systemRole`, the transaction runs `SET LOCAL ROLE <systemRole>`. That role needs `BYPASSRLS` and
the table grants, and the service's login role must be a member of it:

```sql
create role core_ops nologin bypassrls;
grant core_ops to core;
grant select, insert, update, delete on all tables in schema identity to core_ops;
```

Without `systemRole`, system scope only waives the tenant requirement: RLS tables return no rows.

### Tests

`src/prisma-tenant/index.spec.ts` starts Postgres with testcontainers, generates a client from
`src/prisma-tenant/testdata/schema.prisma` into `node_modules/.prisma-tenant-test` and checks
cross-tenant reads, updates and deletes through Prisma and Kysely. It needs Docker and the
dev dependencies `prisma`, `pg`, `@types/pg` and `@testcontainers/postgresql`.
