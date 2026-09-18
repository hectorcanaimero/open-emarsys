import { expect, test } from '@playwright/test';
import { alerts, createUser, demoAdmin, login, nextTotp, tokenFor, uiLogin } from './helpers';

// FR-3: login, lockout, MFA.
test.describe('auth', () => {
  test('1. login, wrong password and lockout at the 5th failure', async ({ page }) => {
    const demo = demoAdmin();
    await uiLogin(page, demo.email, demo.password);
    await expect(page).toHaveURL(/\/es\/?$/);
    await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();

    // A throwaway user, so locking it doesn't affect the rest of the suite.
    const user = await createUser(await tokenFor(demo.email, demo.password), 'lock');
    await page.context().clearCookies();
    await uiLogin(page, user.email, 'wrong-password-123', /never/);
    await expect(alerts(page)).toHaveText('Email o contraseña incorrectos.');

    // The UI attempt above was failure 1; 2 to 4 are plain 401s...
    for (let i = 2; i <= 4; i++) expect((await login(user.email, 'wrong-password-123')).status).toBe(401);
    // ...the 5th locks the account (423, as core's auth suite pins), and then even the right
    // password is refused.
    expect((await login(user.email, 'wrong-password-123')).status).toBe(423);
    expect((await login(user.email, user.password)).status).toBe(423);
    await uiLogin(page, user.email, user.password, /never/);
    await expect(alerts(page)).toContainText('bloqueada');
    await expect(page).toHaveURL(/\/login/);
  });

  test('2. enable MFA with a computed TOTP and log in with the code', async ({ page }) => {
    const demo = demoAdmin();
    const user = await createUser(await tokenFor(demo.email, demo.password), 'mfa');
    await uiLogin(page, user.email, user.password);

    await page.goto('/es/profile/security');
    await page.getByRole('button', { name: 'Activar MFA', exact: true }).click();
    const hint = await page.getByText(/Ingresa esta clave:/).innerText();
    const secret = /clave:\s*([A-Z2-7]+)/.exec(hint)![1]!;
    const enrollCode = await nextTotp(secret);
    await page.locator('#confirm-code').fill(enrollCode);
    await page.getByRole('button', { name: 'Confirmar y activar' }).click();
    await expect(page.getByText('MFA está activo.')).toBeVisible();

    await page.context().clearCookies();
    await uiLogin(page, user.email, user.password, /\/es\/mfa/);
    await expect(page.getByRole('heading', { name: 'Verificación en dos pasos' })).toBeVisible();
    await page.getByLabel('Código de 6 dígitos').fill(await nextTotp(secret, enrollCode));
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(page).toHaveURL(/\/es\/?$/);
    await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();

    // The API agrees: a password alone is now only an MFA challenge.
    const challenge = await login(user.email, user.password);
    expect(challenge.body.mfa_required).toBe(true);
  });
});
