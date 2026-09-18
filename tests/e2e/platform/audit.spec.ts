import { expect, test } from '@playwright/test';
import { admin, createUser, demoAdmin, tokenFor, uiLogin } from './helpers';

// FR-6: deleting a user leaves an audit entry.
test('7. deleting a user shows up in the audit log', async ({ page }) => {
  const demo = demoAdmin();
  const token = await tokenFor(demo.email, demo.password);
  const user = await createUser(token, 'doomed');

  await uiLogin(page, demo.email, demo.password);
  await page.goto('/es/settings/users');
  const row = page.getByRole('row').filter({ hasText: user.email });
  await expect(row).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await row.getByRole('button', { name: /^Borrar/ }).click();
  await expect(row).toHaveCount(0);

  // Entries travel through the event bus, so give the audit consumer a moment.
  await expect
    .poll(async () => {
      const log = await admin('GET', '/audit-log?limit=50', token);
      return log.body.items.some(
        (e: { action: string; resource_id: string | null }) => e.action === 'users.delete' && e.resource_id === user.id
      );
    })
    .toBe(true);

  await page.goto('/es/developer/audit');
  await expect(page.getByRole('cell', { name: 'users.delete', exact: true }).first()).toBeVisible();
});
