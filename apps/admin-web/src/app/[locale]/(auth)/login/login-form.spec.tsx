import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import authEs from '../../../../../messages/es/auth.json';
import { LoginForm } from './login-form';

function renderForm() {
  return render(
    <NextIntlClientProvider locale="es" messages={{ auth: authEs }}>
      <LoginForm next="/es" />
    </NextIntlClientProvider>
  );
}

function coreSays(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
}

async function submit() {
  fireEvent.change(screen.getByLabelText(authEs.email), { target: { value: 'a@b.co' } });
  fireEvent.change(screen.getByLabelText(authEs.password), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: authEs.login.submit }));
  return screen.findByRole('alert');
}

afterEach(() => vi.unstubAllGlobals());

describe('LoginForm', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows one message for any credential error', async () => {
    coreSays({ error: 'invalid' });
    const { container } = renderForm();
    expect(await submit()).toHaveTextContent(authEs.errors.invalid);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('warns that the account is locked', async () => {
    coreSays({ error: 'locked', retryAfter: 900 });
    renderForm();
    expect(await submit()).toHaveTextContent('15 min');
  });
});
