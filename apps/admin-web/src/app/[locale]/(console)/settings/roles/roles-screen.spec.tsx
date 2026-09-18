import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { http, HttpResponse } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import settingsEs from '../../../../../../messages/es/settings.json';
import { server } from '../lib/msw-server';
import { RolesScreen } from './roles-screen';

// Browser calls go through the same-origin proxy (src/app/api/admin).
const BASE = '/api/admin';

const adminRole = {
  id: 'role-admin',
  name: 'Admin',
  permissions: [{ module: 'platform', action: 'admin' }],
  created_at: '2024-01-01T00:00:00Z',
};

const supportRole = {
  id: 'role-support',
  name: 'Support',
  permissions: [],
  created_at: '2024-01-01T00:00:00Z',
};

function renderScreen() {
  return render(
    <NextIntlClientProvider locale="es" messages={{ settings: settingsEs }}>
      <RolesScreen />
    </NextIntlClientProvider>
  );
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('RolesScreen', () => {
  it('edits the permission matrix using only the keyboard', async () => {
    let savedBody: unknown;
    server.use(
      http.get(`${BASE}/roles`, () =>
        HttpResponse.json({ items: [supportRole], next_cursor: null })
      ),
      http.patch(`${BASE}/roles/role-support`, async ({ request }) => {
        savedBody = await request.json();
        return HttpResponse.json({ ...supportRole, permissions: [{ module: 'contacts', action: 'view' }] });
      })
    );

    const user = userEvent.setup();
    renderScreen();

    await screen.findByText('Support');

    const editButton = screen.getByRole('button', { name: 'Editar permisos' });
    editButton.focus();
    await user.keyboard('{Enter}');

    const checkbox = await screen.findByRole('checkbox', { name: 'Contactos · Ver' });
    expect(checkbox).not.toBeChecked();
    checkbox.focus();
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();

    const saveButton = screen.getByRole('button', { name: 'Guardar permisos' });
    saveButton.focus();
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(savedBody).toEqual({ permissions: [{ module: 'contacts', action: 'view' }] })
    );
  });

  it('does not allow deleting a default role', async () => {
    server.use(
      http.get(`${BASE}/roles`, () => HttpResponse.json({ items: [adminRole], next_cursor: null }))
    );

    renderScreen();

    await screen.findByText('Admin');
    expect(screen.getByRole('button', { name: 'Borrar — Admin' })).toBeDisabled();
  });

  it('has no accessibility violations with the matrix open', async () => {
    server.use(
      http.get(`${BASE}/roles`, () =>
        HttpResponse.json({ items: [adminRole, supportRole], next_cursor: null })
      )
    );

    const user = userEvent.setup();
    const { container } = renderScreen();

    await screen.findByText('Support');
    const editButtons = screen.getAllByRole('button', { name: 'Editar permisos' });
    await user.click(editButtons[1]!);
    await screen.findByRole('checkbox', { name: 'Contactos · Ver' });

    expect(await axe(container)).toHaveNoViolations();
  });
});
