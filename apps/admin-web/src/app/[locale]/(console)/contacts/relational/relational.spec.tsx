import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import detail from '../../../../../../messages/es/contacts-detail.json';
import relational from '../../../../../../messages/es/contacts-relational.json';
import { ContactDetail } from '../[id]/contact-detail';
import { GdprScreen } from '../gdpr/gdpr-screen';
import { RelationalScreen } from './relational-screen';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ locale: 'es' }),
  usePathname: () => '/contacts',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const BASE = '/api/admin';
const server = setupServer();
type Table = { id: string; name: string; key_field: string; columns: unknown[]; created_at: string; updated_at: string };
let tables: Table[];
let created: unknown;
let forgetCalls: number;

const MASCOTAS: Table = {
  id: 't-1',
  name: 'mascotas',
  key_field: 'nombre',
  columns: [
    { name: 'nombre', type: 'text' },
    { name: 'especie', type: 'text' },
  ],
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function backend() {
  tables = [];
  created = null;
  forgetCalls = 0;
  const l = (n: string) => ({ es: n, pt: n, en: n });
  server.use(
    http.get(`${BASE}/relational-tables`, () => HttpResponse.json({ items: tables, next_cursor: null })),
    http.post(`${BASE}/relational-tables`, async ({ request }) => {
      created = await request.json();
      const body = created as Omit<Table, 'id'>;
      const row = { ...MASCOTAS, ...body };
      tables = [row];
      return HttpResponse.json(row, { status: 201 });
    }),
    http.get(`${BASE}/fields`, () =>
      HttpResponse.json({
        items: [
          { field_id: 3, api_name: 'email', type: 'text', labels: l('Email'), choices: [], read_only: false, is_system: true },
        ],
      })
    ),
    http.get(`${BASE}/contacts/c-1`, () =>
      HttpResponse.json({
        id: 'c-1',
        version: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        fields: { '3': 'ana@example.com' },
        consents: { email: null, sms: null, push: null },
        lists: [],
      })
    ),
    http.get(`${BASE}/contacts/c-1/consents`, () => HttpResponse.json({ items: [], next_cursor: null })),
    http.get(`${BASE}/contacts/c-1/relational/t-1`, () =>
      HttpResponse.json({
        items: [{ key: 'firulais', data: { nombre: 'Firulais', especie: 'perro' }, updated_at: '2024-02-01T00:00:00Z' }],
        next_cursor: null,
      })
    ),
    http.post(`${BASE}/contacts/c-1/gdpr/forget`, () => {
      forgetCalls++;
      return HttpResponse.json({ id: 'g-1', kind: 'forget', status: 'queued' }, { status: 202 });
    })
  );
}

const wrap = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider
      locale="es"
      messages={{ 'contacts-detail': detail, 'contacts-relational': relational }}
      formats={{ dateTime: { shortWithTime: { dateStyle: 'medium', timeStyle: 'short' } } }}
      timeZone="UTC"
    >
      {ui}
    </NextIntlClientProvider>
  );

describe('relational tables', () => {
  it('creates the "mascotas" table with typed columns', async () => {
    backend();
    const user = userEvent.setup();
    const { container } = wrap(<RelationalScreen />);
    await screen.findByText('Todavía no hay tablas relacionales.');

    await user.type(screen.getByLabelText('Nombre de la tabla'), 'mascotas');
    await user.type(screen.getByLabelText('Nombre de columna 1'), 'nombre');
    await user.click(screen.getByRole('button', { name: 'Agregar otra columna' }));
    await user.type(screen.getByLabelText('Nombre de columna 2'), 'especie');
    await user.selectOptions(screen.getByLabelText('Tipo de columna 2'), 'text');
    await user.click(screen.getByRole('button', { name: 'Crear tabla' }));

    expect(await screen.findByRole('rowheader', { name: 'mascotas' })).toBeInTheDocument();
    expect(created).toEqual({
      name: 'mascotas',
      key_field: 'nombre',
      columns: [
        { name: 'nombre', type: 'text' },
        { name: 'especie', type: 'text' },
      ],
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('contact record', () => {
  it('shows the rows of "mascotas" in its tab', async () => {
    backend();
    tables = [MASCOTAS];
    const { container } = wrap(<ContactDetail id="c-1" />);

    expect(await screen.findByRole('tab', { name: 'mascotas' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('cell', { name: 'Firulais' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'perro' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Olvidar contacto' })).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('enables "Olvidar contacto" only once the exact email is typed', async () => {
    backend();
    const user = userEvent.setup();
    const { container } = wrap(<ContactDetail id="c-1" permissions={['contacts:view', 'contacts:admin']} />);

    const forget = await screen.findByRole('button', { name: 'Olvidar contacto' });
    const box = screen.getByLabelText(/escribí el email del contacto/);
    expect(forget).toBeDisabled();

    await user.type(box, 'ana@example.co');
    expect(forget).toBeDisabled();
    await user.type(box, 'm');
    expect(forget).toBeEnabled();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(forget);
    await screen.findByText('La solicitud de olvido está en curso.');
    expect(forgetCalls).toBe(1);
  });
});

describe('gdpr history', () => {
  it('lists requests with their status', async () => {
    server.use(
      http.get(`${BASE}/gdpr-requests`, () =>
        HttpResponse.json({
          items: [
            { id: 'g-1', contact_id: null, kind: 'forget', status: 'done', requested_at: '2024-05-01T10:00:00Z', completed_at: '2024-05-01T10:01:00Z', result_url: null, result_expires_at: null },
          ],
          next_cursor: null,
        })
      )
    );
    const { container } = wrap(<GdprScreen />);

    expect(await screen.findByRole('cell', { name: 'Olvido' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Completada' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
