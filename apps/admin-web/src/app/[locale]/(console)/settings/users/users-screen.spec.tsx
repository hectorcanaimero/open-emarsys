import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { http, HttpResponse } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import settingsEs from '../../../../../../messages/es/settings.json';
import { server } from '../lib/msw-server';
import { UsersScreen } from './users-screen';

const BASE = 'http://localhost:8080/admin/v1';

const roles = [
  { id: 'role-admin', name: 'Admin', permissions: [], created_at: '2024-01-01T00:00:00Z' },
  { id: 'role-viewer', name: 'Viewer', permissions: [], created_at: '2024-01-01T00:00:00Z' },
];

function adminUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    tenant_id: 'tenant-1',
    email: 'admin@demo.local',
    name: 'Admin User',
    locale: 'es',
    status: 'active',
    mfa_enabled: false,
    role_ids: ['role-admin'],
    created_at: '2024-01-01T00:00:00Z',
    last_login_at: null,
    ...overrides,
  };
}

function renderScreen() {
  return render(
    <NextIntlClientProvider locale="es" messages={{ settings: settingsEs }}>
      <UsersScreen />
    </NextIntlClientProvider>
  );
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe('UsersScreen', () => {
  it('invites a user by email with a role', async () => {
    let invitedBody: unknown;
    server.use(
      http.get(`${BASE}/users`, () =>
        HttpResponse.json({ items: [adminUser()], next_cursor: null })
      ),
      http.get(`${BASE}/roles`, () => HttpResponse.json({ items: roles, next_cursor: null })),
      http.post(`${BASE}/users/invitations`, async ({ request }) => {
        invitedBody = await request.json();
        return HttpResponse.json(
          {
            id: 'inv-1',
            user_id: 'user-2',
            email: 'new@demo.local',
            expires_at: '2024-01-08T00:00:00Z',
          },
          { status: 201 }
        );
      })
    );

    const user = userEvent.setup();
    renderScreen();

    await screen.findByText('admin@demo.local');

    await user.type(screen.getByLabelText('Email'), 'new@demo.local');
    await user.click(screen.getByRole('checkbox', { name: 'Viewer' }));
    await user.click(screen.getByRole('button', { name: 'Enviar invitación' }));

    await screen.findByText('Invitación enviada a new@demo.local.');
    expect(invitedBody).toEqual({ email: 'new@demo.local', role_ids: ['role-viewer'] });
  });

  it('shows the last-admin error when deleting the only Admin', async () => {
    server.use(
      http.get(`${BASE}/users`, () =>
        HttpResponse.json({ items: [adminUser()], next_cursor: null })
      ),
      http.get(`${BASE}/roles`, () => HttpResponse.json({ items: roles, next_cursor: null })),
      http.delete(`${BASE}/users/user-1`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: 'cannot delete the last Admin',
          },
          { status: 409 }
        )
      )
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const user = userEvent.setup();
    renderScreen();

    await screen.findByText('admin@demo.local');
    await user.click(screen.getByRole('button', { name: 'Borrar — admin@demo.local' }));

    await screen.findByText('No se puede borrar ni desactivar al último Admin del tenant.');
  });

  it('has no accessibility violations', async () => {
    server.use(
      http.get(`${BASE}/users`, () =>
        HttpResponse.json({ items: [adminUser()], next_cursor: null })
      ),
      http.get(`${BASE}/roles`, () => HttpResponse.json({ items: roles, next_cursor: null }))
    );

    const { container } = renderScreen();
    await screen.findByText('admin@demo.local');
    expect(await axe(container)).toHaveNoViolations();
  });
});
