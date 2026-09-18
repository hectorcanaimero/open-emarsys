import { render, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import platformEs from '../../../../../../messages/es/platform.json';
import { TenantsClient } from './tenants-client';

// Browser calls go through the same-origin proxy (src/app/api/admin).
const BASE_URL = '/api/admin';

const activeTenant = {
  id: '0191e4a2-1111-7000-8000-000000000001',
  name: 'Acme Corp',
  timezone: 'America/Mexico_City',
  default_locale: 'es' as const,
  limits: {
    max_contacts: 1000,
    max_emails_per_month: null,
    max_users: 10,
    max_api_requests_per_minute: null,
  },
  status: 'active' as const,
  created_at: '2026-01-15T00:00:00Z',
};

const server = setupServer(
  http.get(`${BASE_URL}/tenants`, () =>
    HttpResponse.json({ items: [activeTenant], next_cursor: null })
  ),
  http.post(`${BASE_URL}/tenants`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(
      {
        id: '0191e4a2-2222-7000-8000-000000000002',
        status: 'active',
        created_at: '2026-02-01T00:00:00Z',
        ...body,
      },
      { status: 201 }
    );
  }),
  http.patch(`${BASE_URL}/tenants/:id`, async ({ request, params }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({ ...activeTenant, id: params.id, ...body });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderClient() {
  return render(
    <NextIntlClientProvider locale="es" messages={{ platform: platformEs }}>
      <TenantsClient />
    </NextIntlClientProvider>
  );
}

describe('TenantsClient', () => {
  it('shows a loading state and then the tenant list', async () => {
    renderClient();

    expect(screen.getByText(platformEs.states.loading)).toBeInTheDocument();
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText(platformEs.status.active)).toBeInTheDocument();
  });

  it('shows the empty state when there are no tenants', async () => {
    server.use(
      http.get(`${BASE_URL}/tenants`, () => HttpResponse.json({ items: [], next_cursor: null }))
    );
    renderClient();

    expect(await screen.findByText(platformEs.states.empty)).toBeInTheDocument();
  });

  it('shows an error state on failure', async () => {
    server.use(http.get(`${BASE_URL}/tenants`, () => HttpResponse.error()));
    renderClient();

    expect(await screen.findByText(platformEs.states.error)).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderClient();
    await screen.findByText('Acme Corp');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations with the create dialog open', async () => {
    const { container } = renderClient();
    await screen.findByText('Acme Corp');

    fireEvent.click(screen.getByRole('button', { name: platformEs.actions.newTenant }));
    await screen.findByRole('dialog');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('creates a tenant, validating the time zone first', async () => {
    server.use(
      http.get(`${BASE_URL}/tenants`, () => HttpResponse.json({ items: [], next_cursor: null }))
    );
    renderClient();
    await screen.findByText(platformEs.states.empty);

    fireEvent.click(screen.getByRole('button', { name: platformEs.actions.newTenant }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(platformEs.fields.name), {
      target: { value: 'New Tenant' },
    });
    fireEvent.change(within(dialog).getByLabelText(platformEs.fields.timezone), {
      target: { value: 'Not/AZone' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: platformEs.actions.save }));

    expect(await within(dialog).findByText(platformEs.errors.timezoneInvalid)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(platformEs.fields.timezone), {
      target: { value: 'America/Mexico_City' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: platformEs.actions.save }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('New Tenant')).toBeInTheDocument();
  });

  it('suspends a tenant after confirmation', async () => {
    renderClient();
    await screen.findByText('Acme Corp');

    fireEvent.click(screen.getByRole('button', { name: platformEs.actions.suspend }));

    const confirmDialog = await screen.findByRole('alertdialog');
    expect(
      within(confirmDialog).getByText(
        platformEs.tenants.suspendConfirm.replace('{name}', activeTenant.name)
      )
    ).toBeInTheDocument();

    fireEvent.click(within(confirmDialog).getByRole('button', { name: platformEs.actions.confirm }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(await screen.findByText(platformEs.status.suspended)).toBeInTheDocument();
  });
});
