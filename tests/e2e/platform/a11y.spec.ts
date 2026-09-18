import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { demoAdmin, uiLogin } from './helpers';

// NFR-15: no serious or critical axe violations (WCAG 2.1 A/AA) on the main screens.
async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('8. axe finds no serious violations on login and the console screens', async ({ page }) => {
  await page.goto('/es/login');
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  expect(await seriousViolations(page), 'login').toEqual([]);

  const demo = demoAdmin();
  await uiLogin(page, demo.email, demo.password);
  const screens: [string, string, string][] = [
    ['dashboard', '/es', 'Panel'],
    ['users', '/es/settings/users', 'Usuarios'],
    ['roles', '/es/settings/roles', 'Roles'],
    ['credentials', '/es/developer/credentials', 'Credenciales de API'],
    ['audit', '/es/developer/audit', 'Audit log'],
  ];
  for (const [name, url, heading] of screens) {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    // Tables load after the heading renders.
    await page.waitForLoadState('networkidle');
    expect(await seriousViolations(page), name).toEqual([]);
  }
});
