import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import developerEs from '../../../../../../messages/es/developer.json';
import { CredentialsView } from './credentials-view';

// Browser calls go through the same-origin proxy (src/app/api/admin).
const BASE_URL = '/api/admin';

const activeClient = {
  id: '11111111-1111-1111-1111-111111111111',
  client_id: 'client_existing',
  name: 'Warehouse sync',
  scopes: ['contacts:view'],
  status: 'active' as const,
  created_at: '2026-01-01T00:00:00Z',
  revoked_at: null,
  last_used_at: null,
};

const server = setupServer(
  http.get(`${BASE_URL}/api-clients`, () =>
    HttpResponse.json({ items: [activeClient], next_cursor: null })
  )
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderView() {
  return render(
    <NextIntlClientProvider locale="es" messages={{ developer: developerEs }}>
      <CredentialsView />
    </NextIntlClientProvider>
  );
}

describe('CredentialsView', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderView();
    await screen.findByText('Warehouse sync');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('lists existing clients without ever showing a secret', async () => {
    renderView();
    await screen.findByText('Warehouse sync');
    expect(screen.getByText('client_existing')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the client_secret only in the creation dialog, and never again after a reload', async () => {
    server.use(
      http.post(`${BASE_URL}/api-clients`, () =>
        HttpResponse.json(
          {
            id: '22222222-2222-2222-2222-222222222222',
            client_id: 'client_new',
            name: 'New integration',
            scopes: ['contacts:view'],
            status: 'active',
            created_at: '2026-02-01T00:00:00Z',
            revoked_at: null,
            last_used_at: null,
            client_secret: 'super-secret-value',
          },
          { status: 201 }
        )
      )
    );

    const { unmount } = renderView();
    await screen.findByText('Warehouse sync');

    fireEvent.click(screen.getByRole('button', { name: developerEs.credentials.newButton }));

    const dialog = screen.getByRole('dialog', {
      name: developerEs.credentials.createDialog.title,
    });
    fireEvent.change(within(dialog).getByLabelText(developerEs.credentials.createDialog.nameLabel), {
      target: { value: 'New integration' },
    });
    fireEvent.click(within(dialog).getByLabelText('contacts:view'));
    fireEvent.click(within(dialog).getByRole('button', { name: developerEs.credentials.createDialog.submit }));

    const secretDialog = await screen.findByRole('dialog', {
      name: developerEs.credentials.secretDialog.title,
    });
    expect(within(secretDialog).getByText('super-secret-value')).toBeInTheDocument();
    expect(within(secretDialog).getByText('client_new')).toBeInTheDocument();

    fireEvent.click(within(secretDialog).getByRole('button', { name: developerEs.credentials.secretDialog.done }));
    expect(screen.queryByText('super-secret-value')).not.toBeInTheDocument();

    // Simulate a reload: remount the component from scratch.
    unmount();
    server.use(
      http.get(`${BASE_URL}/api-clients`, () =>
        HttpResponse.json({
          items: [
            activeClient,
            {
              id: '22222222-2222-2222-2222-222222222222',
              client_id: 'client_new',
              name: 'New integration',
              scopes: ['contacts:view'],
              status: 'active',
              created_at: '2026-02-01T00:00:00Z',
              revoked_at: null,
              last_used_at: null,
            },
          ],
          next_cursor: null,
        })
      )
    );
    renderView();
    await screen.findByText('New integration');
    expect(screen.queryByText('super-secret-value')).not.toBeInTheDocument();
  });

  it('copies the secret to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    server.use(
      http.post(`${BASE_URL}/api-clients`, () =>
        HttpResponse.json(
          {
            id: '33333333-3333-3333-3333-333333333333',
            client_id: 'client_copy',
            name: 'Copy test',
            scopes: ['jobs:view'],
            status: 'active',
            created_at: '2026-02-01T00:00:00Z',
            revoked_at: null,
            last_used_at: null,
            client_secret: 'copy-me',
          },
          { status: 201 }
        )
      )
    );

    renderView();
    await screen.findByText('Warehouse sync');
    fireEvent.click(screen.getByRole('button', { name: developerEs.credentials.newButton }));
    const dialog = screen.getByRole('dialog', {
      name: developerEs.credentials.createDialog.title,
    });
    fireEvent.change(within(dialog).getByLabelText(developerEs.credentials.createDialog.nameLabel), {
      target: { value: 'Copy test' },
    });
    fireEvent.click(within(dialog).getByLabelText('jobs:view'));
    fireEvent.click(within(dialog).getByRole('button', { name: developerEs.credentials.createDialog.submit }));

    const secretDialog = await screen.findByRole('dialog', {
      name: developerEs.credentials.secretDialog.title,
    });
    fireEvent.click(within(secretDialog).getByRole('button', { name: developerEs.credentials.secretDialog.copy }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('copy-me'));
  });

  it('revokes a client only after confirmation', async () => {
    server.use(
      http.post(`${BASE_URL}/api-clients/:id/revoke`, () =>
        HttpResponse.json({ ...activeClient, status: 'revoked', revoked_at: '2026-03-01T00:00:00Z' })
      )
    );

    renderView();
    await screen.findByText('Warehouse sync');

    fireEvent.click(screen.getByRole('button', { name: developerEs.credentials.revokeButton }));

    const dialog = await screen.findByRole('dialog', {
      name: developerEs.credentials.revokeDialog.title,
    });

    // Cancelling leaves the client active.
    fireEvent.click(within(dialog).getByRole('button', { name: developerEs.credentials.revokeDialog.cancel }));
    expect(screen.getByText(developerEs.credentials.status.active)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: developerEs.credentials.revokeButton }));
    const confirmDialog = await screen.findByRole('dialog', {
      name: developerEs.credentials.revokeDialog.title,
    });
    fireEvent.click(
      within(confirmDialog).getByRole('button', { name: developerEs.credentials.revokeDialog.confirm })
    );

    await waitFor(() =>
      expect(screen.getByText(developerEs.credentials.status.revoked)).toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: developerEs.credentials.revokeButton })).not.toBeInTheDocument();
  });
});
