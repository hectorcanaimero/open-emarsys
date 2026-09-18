import { expect, test } from '@playwright/test';
import { demoAdmin, uiLogin } from './helpers';

// FR-5: the console is translated to es, pt and en.
test('6. switching to pt and en translates navigation and forms', async ({ page }) => {
  await page.goto('/pt/login');
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
  await expect(page.getByLabel('Senha')).toBeVisible();
  await page.goto('/en/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();

  const demo = demoAdmin();
  await uiLogin(page, demo.email, demo.password);
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();

  await page.getByRole('button', { name: 'Cambiar idioma' }).click();
  await page.getByRole('menuitem', { name: 'Português' }).click();
  await expect(page).toHaveURL(/\/pt\/?$/);
  await expect(page.getByRole('heading', { name: 'Painel' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible();
  await page.goto('/pt/settings/users');
  await expect(page.getByRole('heading', { name: 'Usuários', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Convidar usuário' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar convite' })).toBeVisible();

  await page.getByRole('button', { name: 'Alterar idioma' }).click();
  await page.getByRole('menuitem', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/en\/settings\/users/);
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Invite user' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
});
