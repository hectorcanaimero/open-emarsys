import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { TenantContext } from '@oe/ts-common/tenant';
import type { PrismaClient } from '@prisma/client';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { generateTestKeys, signPrincipal, startTestApp, startTestDatabase, type TestKeys } from '../users/testing/harness.js';
import { RolesModule } from './roles.module.js';

jest.setTimeout(180_000);

const PERMS_VIEW = ['identity:view'];
const PERMS_ADMIN = ['identity:admin', 'identity:view'];

describe('roles (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let rawPrisma: PrismaClient;
  let scoped: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  let keys: TestKeys;

  const as = <T>(tenantId: string, fn: () => Promise<T>) => TenantContext.run(tenantId, async () => await fn());

  beforeAll(async () => {
    const db = await startTestDatabase();
    container = db.container;
    rawPrisma = db.prisma;
    scoped = withTenantScope(rawPrisma);
    keys = await generateTestKeys();
    ({ app, baseUrl } = await startTestApp({ imports: [RolesModule], prisma: rawPrisma, keys }));
  });

  afterAll(async () => {
    await app.close();
    await rawPrisma.$disconnect();
    await container.stop();
  });

  async function seedTenant(): Promise<{ tenantId: string; adminRoleId: string; viewerRoleId: string }> {
    const tenantId = randomUUID();
    return as(tenantId, async () => {
      await scoped.tenant.create({ data: { id: tenantId, name: tenantId, timezone: 'UTC' } });
      const admin = await scoped.role.create({ data: { tenantId, name: 'Admin', isDefault: true } });
      const viewer = await scoped.role.create({ data: { tenantId, name: 'Viewer', isDefault: true } });
      return { tenantId, adminRoleId: admin.id, viewerRoleId: viewer.id };
    });
  }

  async function seedUser(tenantId: string, roleId: string, email: string) {
    // Two flat creates, not a nested relational write: `withTenantScope`'s per-operation
    // tenant-scoping only wraps each top-level Prisma Client call, and a nested write bypasses
    // that wrapping for the child operation (it does not run under `TenantContext.run`).
    return as(tenantId, async () => {
      const user = await scoped.user.create({ data: { tenantId, email, status: 'active' } });
      await scoped.userRole.create({ data: { userId: user.id, roleId, tenantId } });
      return user;
    });
  }

  it('a Viewer receives 403 creating a role, an Admin gets 201', async () => {
    const { tenantId, adminRoleId, viewerRoleId } = await seedTenant();
    const adminUser = await seedUser(tenantId, adminRoleId, 'admin@roles.test');
    const viewerUser = await seedUser(tenantId, viewerRoleId, 'viewer@roles.test');
    const adminToken = await signPrincipal(keys, { sub: adminUser.id, tenant_id: tenantId, perms: PERMS_ADMIN });
    const viewerToken = await signPrincipal(keys, { sub: viewerUser.id, tenant_id: tenantId, perms: PERMS_VIEW });

    const body = JSON.stringify({ name: 'Compliance', permissions: [{ module: 'contacts', action: 'view' }] });

    const asViewer = await fetch(`${baseUrl}/admin/v1/roles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json' },
      body,
    });
    expect(asViewer.status).toBe(403);

    const asAdmin = await fetch(`${baseUrl}/admin/v1/roles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body,
    });
    expect(asAdmin.status).toBe(201);
    const created = await asAdmin.json();
    expect(created.permissions).toEqual([{ module: 'contacts', action: 'view' }]);
  });

  it('rejects a permission module outside the F0.6.T2 catalog', async () => {
    const { tenantId, adminRoleId } = await seedTenant();
    const adminUser = await seedUser(tenantId, adminRoleId, 'admin@catalog.test');
    const token = await signPrincipal(keys, { sub: adminUser.id, tenant_id: tenantId, perms: PERMS_ADMIN });

    const res = await fetch(`${baseUrl}/admin/v1/roles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bogus', permissions: [{ module: 'not_a_module', action: 'view' }] }),
    });
    expect(res.status).toBe(400);
  });

  it('updates a role permission set and lists it via cursor pagination', async () => {
    const { tenantId, adminRoleId } = await seedTenant();
    const adminUser = await seedUser(tenantId, adminRoleId, 'admin@update.test');
    const token = await signPrincipal(keys, { sub: adminUser.id, tenant_id: tenantId, perms: PERMS_ADMIN });

    const createRes = await fetch(`${baseUrl}/admin/v1/roles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Marketer2', permissions: [{ module: 'campaigns', action: 'view' }] }),
    });
    const role = await createRes.json();

    const updateRes = await fetch(`${baseUrl}/admin/v1/roles/${role.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: [{ module: 'campaigns', action: 'edit' }] }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.permissions).toEqual([{ module: 'campaigns', action: 'edit' }]);

    const listRes = await fetch(`${baseUrl}/admin/v1/roles`, { headers: { authorization: `Bearer ${token}` } });
    const page = await listRes.json();
    expect(page.items.some((r: { id: string }) => r.id === role.id)).toBe(true);
  });

  it('never deletes a default role, and blocks deleting a role still assigned to users', async () => {
    const { tenantId, adminRoleId } = await seedTenant();
    const adminUser = await seedUser(tenantId, adminRoleId, 'admin@delete.test');
    const token = await signPrincipal(keys, { sub: adminUser.id, tenant_id: tenantId, perms: PERMS_ADMIN });

    const defaultDelete = await fetch(`${baseUrl}/admin/v1/roles/${adminRoleId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(defaultDelete.status).toBe(409);

    const createRes = await fetch(`${baseUrl}/admin/v1/roles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Temp', permissions: [] }),
    });
    const role = await createRes.json();
    await seedUser(tenantId, role.id, 'holder@delete.test');

    const assignedDelete = await fetch(`${baseUrl}/admin/v1/roles/${role.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(assignedDelete.status).toBe(409);

    await as(tenantId, () => scoped.userRole.deleteMany({ where: { roleId: role.id } }));
    const finalDelete = await fetch(`${baseUrl}/admin/v1/roles/${role.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(finalDelete.status).toBe(204);
  });
});
