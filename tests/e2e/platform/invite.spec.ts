import { expect, test } from '@playwright/test';
import { admin, demoAdmin, inviteToken, login, roleIds, TEST_PASSWORD, tokenFor, uiLogin, unique } from './helpers';

// FR-2: invitation -> acceptance -> role assignment -> RBAC.
test('4. admin invites, invitee accepts via the mailed link, gets Viewer and gets 403 creating a role', async ({
  page,
}) => {
  const demo = demoAdmin();
  const email = `${unique('invitee')}@demo.local`;

  await uiLogin(page, demo.email, demo.password);
  await page.goto('/es/settings/users');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('group', { name: 'Roles' }).getByLabel('Marketer').check();
  await page.getByRole('button', { name: 'Enviar invitación' }).click();
  await expect(page.getByRole('status')).toContainText(email);

  // Accept through the link in the mail (read from Mailpit's API).
  const accept = await page.context().newPage();
  await accept.goto(`/es/invite/${await inviteToken(email)}`);
  await accept.getByLabel('Nombre').fill('Invitee E2E');
  await accept.getByLabel('Contraseña', { exact: true }).fill(TEST_PASSWORD);
  await accept.getByLabel('Repite la contraseña').fill(TEST_PASSWORD);
  await accept.getByRole('button', { name: 'Activar cuenta' }).click();
  await expect(accept.getByText('Tu cuenta está activa.')).toBeVisible();
  await accept.close();

  // Swap Marketer for Viewer in the users screen.
  await page.reload();
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row).toContainText('Activo');
  await row.getByRole('button', { name: /^Editar roles/ }).click();
  await row.getByLabel('Marketer').uncheck();
  await row.getByLabel('Viewer').check();
  await row.getByRole('button', { name: 'Guardar roles' }).click();
  await expect(row.getByRole('cell', { name: 'Viewer', exact: true })).toBeVisible();

  const viewerToken = await tokenFor(email, TEST_PASSWORD);
  // Viewer only reads the marketing modules, not identity, so role ids come from the admin.
  const adminToken = await tokenFor(demo.email, demo.password);
  const roles = await roleIds(adminToken);
  const me = (await admin('GET', '/users?limit=200', adminToken)).body.items.find(
    (u: { email: string }) => u.email === email
  );
  expect(me.role_ids).toEqual([roles.Viewer]);

  const create = await admin('POST', '/roles', viewerToken, { name: unique('role'), permissions: [] });
  expect(create.status).toBe(403);
  expect((await login(email, TEST_PASSWORD)).status).toBe(200);
});
