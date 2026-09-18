import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import contactsNav from '@/nav/contacts';
import { filterNavByPermission } from '@/nav/types';
import messages from '../../../../../../messages/es/contacts-fields.json';
import { FieldsScreen } from './fields-screen';

const BASE = '/api/admin';
const server = setupServer();
let fields: Array<Record<string, unknown>>;
let lastBody: Record<string, any>;

const labels = (s: string) => ({ es: s, pt: s, en: s });

function useBackend() {
  server.use(
    http.get(`${BASE}/fields`, () => HttpResponse.json({ items: fields })),
    http.post(`${BASE}/fields`, async ({ request }) => {
      lastBody = (await request.json()) as Record<string, any>;
      const field = {
        ...lastBody,
        field_id: 1000,
        read_only: false,
        is_system: false,
        deleted_at: null,
        unique: false,
        choices: lastBody.choices.map((c: object, i: number) => ({ ...c, id: i + 1 })),
      };
      fields.push(field);
      return HttpResponse.json(field, { status: 201 });
    }),
    http.patch(`${BASE}/fields/1000`, async ({ request }) => {
      lastBody = (await request.json()) as Record<string, any>;
      const field = fields.find((f) => f.field_id === 1000)!;
      Object.assign(field, lastBody);
      return HttpResponse.json(field);
    })
  );
}

const wrap = () =>
  render(
    <NextIntlClientProvider locale="es" messages={{ 'contacts-fields': messages }}>
      <FieldsScreen />
    </NextIntlClientProvider>
  );

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('fields manager', () => {
  it('creates a single choice field with 3 options, renames it and keeps its ID', async () => {
    fields = [
      {
        field_id: 3,
        api_name: 'email',
        type: 'text',
        labels: labels('Email'),
        choices: [],
        unique: true,
        read_only: false,
        is_system: true,
        deleted_at: null,
      },
    ];
    useBackend();
    const user = userEvent.setup();
    const { container } = wrap();

    await screen.findByText('email');
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Nuevo campo' }));
    await user.type(screen.getByLabelText('Nombre API'), 'talle');
    await user.selectOptions(screen.getByLabelText('Tipo'), 'single_choice');
    for (const l of ['es', 'pt', 'en']) await user.type(screen.getByLabelText(`Etiqueta (${l})`), 'Talle');
    for (const n of [1, 2, 3]) {
      await user.click(screen.getByRole('button', { name: 'Agregar opción' }));
      await user.type(screen.getByLabelText(`Nombre API de la opción ${n}`), `t${n}`);
      for (const l of ['es', 'pt', 'en'])
        await user.type(screen.getByLabelText(`Etiqueta de la opción ${n} (${l})`), `T${n}`);
    }
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Guardar' }));

    const row = (await screen.findByText('talle')).closest('tr')!;
    expect(lastBody.choices).toHaveLength(3);
    expect(within(row).getByText('1000')).toBeInTheDocument();
    expect(within(row).getAllByRole('listitem')).toHaveLength(3);

    await user.click(within(row).getByRole('button', { name: 'Editar talle' }));
    expect(screen.getByText('ID de opción 1')).toBeInTheDocument();
    const es = screen.getByLabelText('Etiqueta (es)');
    await user.clear(es);
    await user.type(es, 'Tamaño');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));

    await screen.findByText(/Tamaño/);
    expect(lastBody.choices.map((c: { id: number }) => c.id)).toEqual([1, 2, 3]);
    expect(lastBody).not.toHaveProperty('type');
    const renamed = screen.getByText('talle').closest('tr')!;
    expect(within(renamed).getByText('1000')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('contacts nav', () => {
  it('shows the section only with contacts:view', () => {
    expect(filterNavByPermission(contactsNav, [])).toEqual([]);
    expect(filterNavByPermission(contactsNav, ['contacts:view']).map((i) => i.href)).toContain(
      '/contacts/fields'
    );
    expect(contactsNav.every((i) => i.permission === 'contacts:view')).toBe(true);
  });
});
