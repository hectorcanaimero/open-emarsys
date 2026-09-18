import { expect, test } from '@playwright/test';
import { admin, demoAdmin, operator, tokenFor, TEST_PASSWORD, unique } from './helpers';

// FR-1, NFR-8: tenants are isolated.
test('3. operator creates a tenant; its admin sees nothing of the demo tenant', async () => {
  const op = await tokenFor(operator().email, operator().password);
  const demo = demoAdmin();

  const tenants = await admin('GET', '/tenants?limit=200', op);
  const demoTenant = tenants.body.items.find((t: { name: string }) => t.name === 'Tienda Demo');
  expect(demoTenant).toBeTruthy();

  const adminEmail = `${unique('admin')}@nuevo.local`;
  const created = await admin('POST', '/tenants', op, {
    name: unique('Tenant E2E'),
    timezone: 'America/Mexico_City',
    default_locale: 'es',
    admin: { email: adminEmail, password: TEST_PASSWORD },
  });
  expect(created.status).toBe(201);
  expect(created.body.id).not.toBe(demoTenant.id);

  const token = await tokenFor(adminEmail, TEST_PASSWORD);
  const users = await admin('GET', '/users?limit=200', token);
  expect(users.status).toBe(200);
  const emails = users.body.items.map((u: { email: string }) => u.email);
  expect(emails).toEqual([adminEmail]);
  expect(emails).not.toContain(demo.email);
  expect(users.body.items.every((u: { tenant_id: string }) => u.tenant_id === created.body.id)).toBe(true);

  const demoRoles = (await admin('GET', '/roles?limit=200', await tokenFor(demo.email, demo.password))).body.items;
  const ownRoles = (await admin('GET', '/roles?limit=200', token)).body.items;
  const demoRoleIds = new Set(demoRoles.map((r: { id: string }) => r.id));
  expect(ownRoles.length).toBeGreaterThan(0);
  expect(ownRoles.some((r: { id: string }) => demoRoleIds.has(r.id))).toBe(false);

  // Platform routes are for operators only.
  expect((await admin('GET', '/tenants', token)).status).toBe(403);
  expect([403, 404]).toContain((await admin('GET', `/tenants/${demoTenant.id}`, token)).status);
});
