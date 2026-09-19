import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import es from '../../../../../../messages/es/contacts-import.json';
import { ExportsView } from '../exports/exports-view';
import { ImportWizard } from './import-wizard';

const API = '/api/admin';
const UPLOAD_URL = 'http://minio.test/imports/t1/contacts.csv';
const w = es.wizard;

const fields = [
  { field_id: 1, api_name: 'first_name', labels: { es: 'Nombre', pt: 'Nome', en: 'First name' }, unique: false, deleted_at: null },
  { field_id: 3, api_name: 'email', labels: { es: 'Correo', pt: 'E-mail', en: 'Email' }, unique: true, deleted_at: null },
];
const zero = { rows_read: 0, rows_ok: 0, rows_failed: 0 };
const baseJob = {
  id: 'job-1',
  kind: 'import',
  params: {},
  result_url: null,
  result_url_expires_at: null,
  error_report_url: null,
  error_report_url_expires_at: null,
  created_at: '2026-03-01T12:00:00Z',
  finished_at: null,
};

let startBody: unknown = null;
let polls = 0;

const server = setupServer(
  http.get(`*${API}/fields`, () => HttpResponse.json({ items: fields })),
  http.get(`*${API}/lists`, () => HttpResponse.json({ items: [{ id: 'l1', name: 'VIP' }], next_cursor: null })),
  http.get(`*${API}/relational-tables`, () => HttpResponse.json({ items: [], next_cursor: null })),
  http.post(`*${API}/imports/upload-url`, () =>
    HttpResponse.json({ url: UPLOAD_URL, object_key: 'k1', expires_at: '2026-03-01T13:00:00Z' }, { status: 201 })
  ),
  http.put(UPLOAD_URL, () => new HttpResponse(null, { status: 200 })),
  http.post(`*${API}/imports`, () => HttpResponse.json({ ...baseJob, status: 'draft', progress: zero }, { status: 201 })),
  http.post(`*${API}/imports/job-1/preview`, () =>
    HttpResponse.json({
      delimiter: ',',
      encoding: 'utf-8',
      has_header: true,
      columns: ['email', 'nombre', 'notas'],
      rows: [['a@x.com', 'Ana', 'x']],
    })
  ),
  http.post(`*${API}/imports/job-1/start`, async ({ request }) => {
    startBody = await request.json();
    return HttpResponse.json({ ...baseJob, id: 'job-1-run', status: 'queued', progress: zero }, { status: 202 });
  }),
  http.get(`*${API}/jobs/job-1-run`, () => {
    polls += 1;
    return HttpResponse.json(
      polls < 2
        ? { ...baseJob, status: 'running', progress: { rows_read: 1, rows_ok: 1, rows_failed: 0 } }
        : {
            ...baseJob,
            status: 'completed',
            progress: { rows_read: 4, rows_ok: 2, rows_failed: 2 },
            error_report_url: 'http://minio.test/errors.csv',
            error_report_url_expires_at: '2999-01-01T00:00:00Z',
          }
    );
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  startBody = null;
  polls = 0;
});
afterAll(() => server.close());

const wrap = (ui: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="es" messages={{ 'contacts-import': es }} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );

describe('ImportWizard', () => {
  it('runs from CSV upload to a finished job with 2 downloadable errors', async () => {
    const user = userEvent.setup();
    const { container } = wrap(<ImportWizard />);

    const csv = new File(['email,nombre,notas\na@x.com,Ana,x\n'], 'contacts.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText(w.upload.file), csv);
    expect(await screen.findByText('Ana')).toBeInTheDocument(); // local papaparse preview
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: w.upload.submit }));
    await screen.findByText(w.settings.serverPreview);
    await waitFor(() => expect(screen.getByLabelText(w.settings.keyId)).toHaveValue('3'));
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: w.next }));

    // suggestions: email -> by api_name, nombre -> by label, notas -> ignore
    expect(screen.getByLabelText('email')).toHaveValue('3');
    expect(screen.getByLabelText('nombre')).toHaveValue('1');
    expect(screen.getByLabelText('notas')).toHaveValue('');
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: w.next }));

    await user.click(await screen.findByRole('button', { name: w.confirm.start }));
    expect(startBody).toMatchObject({
      mapping: { email: '3', nombre: '1' },
      key_id: '3',
      mode: 'upsert',
      target: 'contacts',
    });

    const link = await screen.findByRole('link', { name: /Descargar reporte de errores \(2\)/ }, { timeout: 6000 });
    expect(link).toHaveAttribute('href', 'http://minio.test/errors.csv');
    expect(await axe(container)).toHaveNoViolations();
  }, 15000);

  it('blocks confirmation when no column maps to the key field', async () => {
    const user = userEvent.setup();
    wrap(<ImportWizard />);
    await user.upload(screen.getByLabelText(w.upload.file), new File(['email\na@x.com\n'], 'c.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: w.upload.submit }));
    await screen.findByText(w.settings.serverPreview);
    await user.click(screen.getByRole('button', { name: w.next }));
    await user.selectOptions(screen.getByLabelText('email'), w.mapping.ignore);
    await user.selectOptions(screen.getByLabelText('nombre'), '1');
    await user.click(screen.getByRole('button', { name: w.next }));
    expect(await screen.findByRole('alert')).toHaveTextContent(w.errors.keyUnmapped);
  });
});

describe('ExportsView', () => {
  it('creates an export and shows the download link', async () => {
    let exportBody: unknown = null;
    const exportJob = { ...baseJob, id: 'job-2', kind: 'export', progress: zero };
    server.use(
      http.get(`*${API}/jobs`, () =>
        HttpResponse.json({
          items: [
            {
              ...exportJob,
              id: 'old',
              status: 'completed',
              result_url: 'http://minio.test/old.csv',
              result_url_expires_at: '2000-01-01T00:00:00Z',
            },
          ],
          next_cursor: null,
        })
      ),
      http.post(`*${API}/exports`, async ({ request }) => {
        exportBody = await request.json();
        return HttpResponse.json({ ...exportJob, status: 'queued' }, { status: 202 });
      }),
      http.get(`*${API}/jobs/job-2`, () =>
        HttpResponse.json({
          ...exportJob,
          status: 'completed',
          result_url: 'http://minio.test/export.csv',
          result_url_expires_at: '2999-01-01T00:00:00Z',
        })
      )
    );

    const user = userEvent.setup();
    const { container } = wrap(<ExportsView />);
    await user.click(await screen.findByLabelText('Correo'));
    await user.selectOptions(screen.getByLabelText(es.exports.scope), 'list:l1');
    await user.click(screen.getByRole('button', { name: es.exports.create }));

    const link = await screen.findByRole('link', { name: es.job.downloadResult });
    expect(link).toHaveAttribute('href', 'http://minio.test/export.csv');
    expect(exportBody).toEqual({ fields: [3], scope: 'list:l1', format: 'csv' });
    // the expired link in the history is not offered
    expect(screen.queryByRole('link', { name: es.exports.history.downloadResult })).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
