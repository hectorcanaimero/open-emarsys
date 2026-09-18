import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import developerEs from '../../../../../../messages/es/developer.json';
import { AuditView } from './audit-view';

const BASE_URL = 'http://localhost:8080/admin/v1';

const entry = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  occurred_at: '2026-03-01T12:00:00Z',
  tenant_id: null,
  actor_type: 'user' as const,
  actor_id: 'user_1',
  action: 'role.updated',
  resource_type: 'role',
  resource_id: 'role_1',
  ip: null,
  changes: { name: { before: 'Old', after: 'New' } },
};

let lastRequestUrl: URL | null = null;

const server = setupServer(
  http.get(`${BASE_URL}/audit-log`, ({ request }) => {
    lastRequestUrl = new URL(request.url);
    return HttpResponse.json({ items: [entry], next_cursor: null });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  lastRequestUrl = null;
});
afterAll(() => server.close());

function renderView() {
  return render(
    <NextIntlClientProvider locale="es" messages={{ developer: developerEs }}>
      <AuditView />
    </NextIntlClientProvider>
  );
}

describe('AuditView', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderView();
    await screen.findByText('role.updated');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('lists audit entries', async () => {
    renderView();
    await screen.findByText('role.updated');
    expect(screen.getByText('user_1')).toBeInTheDocument();
    expect(screen.getByText('role')).toBeInTheDocument();
  });

  it('sends actor, resource type and date range filters to the API', async () => {
    renderView();
    await screen.findByText('role.updated');

    fireEvent.change(screen.getByLabelText(developerEs.audit.filters.actor), {
      target: { value: 'user_42' },
    });
    fireEvent.change(screen.getByLabelText(developerEs.audit.filters.resourceType), {
      target: { value: 'contact' },
    });
    fireEvent.change(screen.getByLabelText(developerEs.audit.filters.from), {
      target: { value: '2026-01-01' },
    });
    fireEvent.change(screen.getByLabelText(developerEs.audit.filters.to), {
      target: { value: '2026-02-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: developerEs.audit.filters.apply }));

    await waitFor(() => expect(lastRequestUrl?.searchParams.get('actor_id')).toBe('user_42'));
    expect(lastRequestUrl?.searchParams.get('resource_type')).toBe('contact');
    expect(lastRequestUrl?.searchParams.get('from')).toContain('2026-01-01');
    expect(lastRequestUrl?.searchParams.get('to')).toContain('2026-02-01');
  });

  it('shows the diff for an entry in a detail dialog', async () => {
    renderView();
    await screen.findByText('role.updated');

    fireEvent.click(screen.getByRole('button', { name: developerEs.audit.table.details }));

    const dialog = await screen.findByRole('dialog', { name: developerEs.audit.detailDialog.title });
    expect(within(dialog).getByText('name')).toBeInTheDocument();
    expect(within(dialog).getByText('"Old"')).toBeInTheDocument();
    expect(within(dialog).getByText('"New"')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: developerEs.audit.detailDialog.close }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
