import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../messages/es/contacts-detail.json';
import { ContactsScreen } from './_components/contacts-screen';
import { ContactDetail } from './[id]/contact-detail';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ locale: 'es' }),
  usePathname: () => '/contacts',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const BASE = '/api/admin';
const labels = (n: string) => ({ es: n, pt: n, en: n });
const field = (field_id: number, api_name: string, type: string, name: string, is_system = true) => ({
  field_id,
  api_name,
  type,
  labels: labels(name),
  choices: [],
  unique: false,
  read_only: false,
  is_system,
  deleted_at: null,
});
const FIELDS = [
  field(1, 'first_name', 'text', 'Nombre'),
  field(2, 'last_name', 'text', 'Apellido'),
  field(3, 'email', 'text', 'Email'),
  field(4, 'external_id', 'text', 'ID externo'),
  field(1001, 'last_purchase', 'date', 'Última compra', false),
];

const server = setupServer();
let contact: Record<string, unknown>;
let consents: Array<Record<string, unknown>>;
let searchedQ: string | null;

function useBackend() {
  contact = {
    id: 'c-1',
    version: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    fields: { '1': 'Ana', '2': 'Pérez', '3': 'ana@example.com', '1001': '2024-03-05' },
    consents: { email: null, sms: null, push: null },
    lists: [{ id: 'l-1', name: 'VIP' }],
  };
  consents = [];
  searchedQ = null;
  server.use(
    http.get(`${BASE}/fields`, () => HttpResponse.json({ items: FIELDS })),
    http.get(`${BASE}/contacts`, ({ request }) => {
      searchedQ = new URL(request.url).searchParams.get('q');
      return HttpResponse.json({ items: [contact], next_cursor: null });
    }),
    http.get(`${BASE}/contacts/c-1`, () => HttpResponse.json(contact)),
    http.patch(`${BASE}/contacts/c-1`, async ({ request }) => {
      const { fields } = (await request.json()) as { fields: Record<string, unknown> };
      contact = { ...contact, fields: { ...(contact.fields as object), ...fields } };
      return HttpResponse.json(contact);
    }),
    http.get(`${BASE}/contacts/c-1/consents`, () =>
      HttpResponse.json({ items: consents, next_cursor: null })
    ),
    http.post(`${BASE}/contacts/c-1/consents`, async ({ request }) => {
      const body = (await request.json()) as { channel: string; value: number; text: string };
      const row = { id: `k-${consents.length}`, ...body, source: 'admin', changed_at: '2024-05-01T15:30:00Z' };
      consents = [row, ...consents];
      contact = {
        ...contact,
        consents: { ...(contact.consents as object), [body.channel]: body.value },
      };
      return HttpResponse.json(row, { status: 201 });
    })
  );
}

const wrap = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="es" messages={{ 'contacts-detail': messages }}>
      {ui}
    </NextIntlClientProvider>
  );

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('contacts search', () => {
  it('searches by email (debounced) and links to the record', async () => {
    useBackend();
    const user = userEvent.setup();
    const { container } = wrap(<ContactsScreen />);

    await user.type(screen.getByLabelText(/Buscar por email/), 'ana@example');
    await vi.waitFor(() => expect(searchedQ).toBe('ana@example'));
    const link = await screen.findByRole('link', { name: 'ana@example.com' });
    expect(link).toHaveAttribute('href', expect.stringContaining('/contacts/c-1'));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('contact detail', () => {
  it('formats dates for the locale and edits a date field', async () => {
    useBackend();
    const user = userEvent.setup();
    const { container } = wrap(<ContactDetail id="c-1" />);

    await screen.findByText('5 de marzo de 2024');
    expect(container.querySelector('[data-slot="timeline"]')).toBeEmptyDOMElement();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Editar Última compra' }));
    const input = screen.getByLabelText('Última compra');
    await user.clear(input);
    await user.type(input, '2024-06-10');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));

    await screen.findByText('10 de junio de 2024');
  });

  it('records a consent change with mandatory text and shows it in the history', async () => {
    useBackend();
    const user = userEvent.setup();
    const { container } = wrap(<ContactDetail id="c-1" />);

    expect(await screen.findAllByText('Sin dato', { selector: 'strong' })).toHaveLength(3);
    expect(screen.getByLabelText('Texto de consentimiento')).toBeRequired();

    await user.type(screen.getByLabelText('Texto de consentimiento'), 'Acepto recibir emails');
    await user.click(screen.getByRole('button', { name: 'Registrar cambio' }));

    const row = (await screen.findByText('Acepto recibir emails', { selector: 'td' })).closest('tr')!;
    expect(row).toHaveTextContent('Acepta');
    expect(row).toHaveTextContent('admin');
    expect(await axe(container)).toHaveNoViolations();
  });
});
