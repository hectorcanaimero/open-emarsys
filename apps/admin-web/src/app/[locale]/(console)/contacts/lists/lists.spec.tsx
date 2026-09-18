import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../../messages/es/contacts-lists.json';
import { ListDetail } from './list-detail';
import { ListsScreen } from './lists-screen';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ locale: 'es' }),
  usePathname: () => '/contacts/lists',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const BASE = '/api/admin';
const ana = { id: 'c-1', fields: { '1': 'Ana', '2': 'Pérez', '3': 'ana@example.com' } };
const server = setupServer();

let lists: Array<Record<string, unknown>>;
let members: string[];

function useBackend() {
  server.use(
    http.get(`${BASE}/lists`, () => HttpResponse.json({ items: lists, next_cursor: null })),
    http.post(`${BASE}/lists`, async ({ request }) => {
      const { name } = (await request.json()) as { name: string };
      const list = { id: 'l-new', name, description: null, member_count: 0 };
      lists.push(list);
      return HttpResponse.json(list, { status: 201 });
    }),
    http.get(`${BASE}/lists/l-1`, () =>
      HttpResponse.json({ id: 'l-1', name: 'VIP', description: null, member_count: members.length })
    ),
    http.get(`${BASE}/lists/l-1/members`, () =>
      HttpResponse.json({
        items: members.map((contact_id) => ({ contact_id, added_at: '2024-01-01T00:00:00Z', fields: ana.fields })),
        next_cursor: null,
      })
    ),
    http.post(`${BASE}/lists/l-1/members`, async ({ request }) => {
      const { contact_ids } = (await request.json()) as { contact_ids: string[] };
      members.push(...contact_ids);
      return HttpResponse.json({ changed: contact_ids.length, not_found: [] });
    }),
    http.delete(`${BASE}/lists/l-1/members`, async ({ request }) => {
      const { contact_ids } = (await request.json()) as { contact_ids: string[] };
      members = members.filter((m) => !contact_ids.includes(m));
      return HttpResponse.json({ changed: contact_ids.length, not_found: [] });
    }),
    http.get(`${BASE}/contacts`, () => HttpResponse.json({ items: [ana], next_cursor: null }))
  );
}

const wrap = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="es" messages={{ 'contacts-lists': messages }}>
      {ui}
    </NextIntlClientProvider>
  );

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('contact lists', () => {
  it('creates a list and shows it with its count', async () => {
    lists = [{ id: 'l-1', name: 'VIP', description: null, member_count: 3 }];
    useBackend();
    const user = userEvent.setup();
    const { container } = wrap(<ListsScreen />);

    await screen.findByText('VIP');
    await user.type(screen.getByLabelText('Nombre de la nueva lista'), 'Newsletter');
    await user.click(screen.getByRole('button', { name: 'Crear lista' }));

    const row = (await screen.findByText('Newsletter')).closest('tr')!;
    expect(row).toHaveTextContent('0');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('adds and removes members and keeps the count updated', async () => {
    members = [];
    useBackend();
    const user = userEvent.setup();
    const { container } = wrap(<ListDetail id="l-1" />);

    await screen.findByText('Sin contactos');
    expect(screen.getByRole('link', { name: 'Importar a esta lista' })).toHaveAttribute(
      'href',
      expect.stringContaining('/contacts/import?target=list%3Al-1')
    );

    await user.type(screen.getByLabelText(/Buscar contactos/), 'ana');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await user.click(await screen.findByRole('button', { name: 'Agregar Ana Pérez' }));
    await screen.findByText('1 contacto');
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar Ana Pérez' }));
    await user.click(screen.getByRole('button', { name: 'Quitar seleccionados' }));
    await screen.findByText('Sin contactos');
    expect(screen.getByText('Esta lista no tiene miembros.')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
