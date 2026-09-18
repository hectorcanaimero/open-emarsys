import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import authEs from '../../../../../../messages/es/auth.json';
import { SecurityPanel, type SecurityActions } from './security-panel';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ locale: 'es' }),
  usePathname: () => '/es/profile/security',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

const actions: SecurityActions = {
  enrollMfa: vi.fn(async () => ({
    status: 'pending' as const,
    qr: 'data:image/png;base64,AAAA',
    secret: 'JBSWY3DPEHPK3PXP',
  })),
  confirmMfa: vi.fn(async () => ({ status: 'ok' as const })),
  disableMfa: vi.fn(async () => ({ status: 'error' as const, error: 'invalidCode' as const })),
  updateLocale: vi.fn(async () => ({ status: 'ok' as const })),
};

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="es" messages={{ auth: authEs }}>
      <SecurityPanel actions={actions} />
    </NextIntlClientProvider>
  );
}

describe('SecurityPanel', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderPanel();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('enrolls MFA with a QR code and confirms it', async () => {
    const { container } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: authEs.security.mfaEnable }));

    expect(await screen.findByRole('img', { name: authEs.security.mfaQrAlt })).toBeInTheDocument();
    expect(screen.getByText(/JBSWY3DPEHPK3PXP/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.change(screen.getAllByLabelText(authEs.code)[0]!, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: authEs.security.mfaConfirm }));
    expect(await screen.findByText(authEs.security.mfaEnabled)).toBeInTheDocument();
  });

  it('reports a wrong code when disabling MFA', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText(authEs.code), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: authEs.security.mfaDisable }));
    expect(await screen.findByRole('alert')).toHaveTextContent(authEs.errors.invalidCode);
  });
});
