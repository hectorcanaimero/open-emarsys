import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import authEs from '../../../../../../messages/es/auth.json';
import type { InviteState } from './actions';
import { InviteForm } from './invite-form';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ locale: 'es' }),
  usePathname: () => '/es/invite/t',
}));

function renderForm(action = vi.fn(async (): Promise<InviteState> => ({ status: 'ok' }))) {
  return render(
    <NextIntlClientProvider locale="es" messages={{ auth: authEs }}>
      <InviteForm action={action} />
    </NextIntlClientProvider>
  );
}

describe('InviteForm', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows the expired-invitation error', async () => {
    const { container } = renderForm(
      vi.fn(async (): Promise<InviteState> => ({ status: 'error', error: 'inviteExpired' }))
    );
    fireEvent.change(screen.getByLabelText(authEs.invite.name), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText(authEs.password), { target: { value: 'x'.repeat(12) } });
    fireEvent.change(screen.getByLabelText(authEs.invite.confirmPassword), {
      target: { value: 'x'.repeat(12) },
    });
    fireEvent.click(screen.getByRole('button', { name: authEs.invite.submit }));

    expect(await screen.findByRole('alert')).toHaveTextContent(authEs.errors.inviteExpired);
    expect(await axe(container)).toHaveNoViolations();
  });
});
