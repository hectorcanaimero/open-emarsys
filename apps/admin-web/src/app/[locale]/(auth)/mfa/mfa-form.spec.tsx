import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import authEs from '../../../../../messages/es/auth.json';
import { MfaForm } from './mfa-form';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ locale: 'es' }),
  usePathname: () => '/es/mfa',
}));

afterEach(() => vi.unstubAllGlobals());

function renderForm() {
  return render(
    <NextIntlClientProvider locale="es" messages={{ auth: authEs }}>
      <MfaForm next="/es" />
    </NextIntlClientProvider>
  );
}

describe('MfaForm', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('sends the user back to login when the challenge expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'expired' })));
    const { container } = renderForm();
    fireEvent.change(screen.getByLabelText(authEs.code), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: authEs.mfa.submit }));

    expect(await screen.findByRole('alert')).toHaveTextContent(authEs.errors.expired);
    expect(screen.getByRole('link', { name: authEs.backToLogin })).toHaveAttribute(
      'href',
      '/es/login?next=%2Fes'
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
