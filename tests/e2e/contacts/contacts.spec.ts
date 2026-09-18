import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { admin, BASE, demoAdmin, http, operator, sleep, TEST_PASSWORD, tokenFor, uiLogin, unique } from '../platform/helpers';
import { badName, emailOf, genCsv } from './fixtures/gen-csv';

// Contacts e2e (F1.6.T3) against the seeded platform, using the seed's demo API client.
// Scenarios share the demo tenant and run in order (workers: 1 in playwright.config.ts).
test.describe.configure({ mode: 'serial' });

const V3 = `${BASE}/api/v3`;
const EMAIL = 3;
const run = unique('c').replace(/[^a-z0-9]/g, '');
const env = (name: string) => process.env[name] ?? (() => { throw new Error(`missing env var ${name} (run make seed)`); })();

/** Public v3 call: unwraps the `{replyCode, data}` envelope. */
async function v3(token: string, method: string, p: string, json?: unknown) {
  const res = await http(method, `${V3}${p}`, { token, json });
  return { status: res.status, code: res.body?.replyCode, data: res.body?.data };
}

async function clientToken(id: string, secret: string): Promise<string> {
  const res = await http('POST', `${V3}/oauth/token`, {
    form: { grant_type: 'client_credentials', client_id: id, client_secret: secret },
  });
  expect(res.status).toBe(200);
  return res.body.access_token;
}

/** Polls GET /jobs/{id} until it leaves queued/running. */
async function waitJob(token: string, id: string, timeoutMs = 120_000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(1_000)) {
    const job = (await v3(token, 'GET', `/jobs/${id}`)).data;
    if (job && !['queued', 'running'].includes(job.status)) return job;
  }
  throw new Error(`job ${id} did not finish in ${timeoutMs} ms`);
}

const emails = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}-${run}-${i}@e2e.local`);
const contactsOf = (list: string[], extra: Record<string, unknown> = {}) =>
  list.map((e) => ({ [EMAIL]: e, 1: 'E2E', ...extra }));
const upsert = (token: string, list: string[], extra?: Record<string, unknown>) =>
  v3(token, 'PUT', '/contact?create_if_not_exists=1', { key_id: String(EMAIL), contacts: contactsOf(list, extra) });
const newList = async (token: string, tag: string) => {
  const name = `${tag} ${run}`;
  return { name, id: (await v3(token, 'POST', '/contactlist', { name })).data.id as string };
};
const listCount = async (token: string, id: string) => (await v3(token, 'GET', `/contactlist/${id}/count`)).data.count as number;

let token: string; // demo API client
let adminToken: string; // demo console admin (admin API)

test.beforeAll(async () => {
  token = await clientToken(env('OE_DEMO_CLIENT_ID'), env('OE_DEMO_CLIENT_SECRET'));
  adminToken = await tokenFor(demoAdmin().email, demoAdmin().password);
});

// FR-7
test('1. a custom field created by API keeps its ID when renamed in the console', async ({ page }) => {
  const name = `campo_${run}`;
  const created = await v3(token, 'POST', '/field', { name, string_id: name, application_type: 'text' });
  expect(created.status).toBe(200);
  const id: number = created.data.id;
  expect(id).toBeGreaterThanOrEqual(1000);

  await uiLogin(page, demoAdmin().email, demoAdmin().password);
  await page.goto('/es/contacts/fields');
  await page.getByRole('button', { name: `Editar ${name}` }).click();
  const renamed = `${name}_nuevo`;
  await page.locator('#ff-api-name').fill(renamed);
  await page.locator('#ff-label-es').fill('Campo renombrado');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByText(renamed, { exact: false }).first()).toBeVisible();

  const fields = (await v3(token, 'GET', '/field')).data as { id: number; string_id: string }[];
  expect(fields.find((f) => f.id === id)?.string_id).toBe(renamed);
  expect(fields.filter((f) => f.string_id === name)).toHaveLength(0);
});

// FR-8
test('2. PUT /contact with 998 valid + 2 invalid: 998 persisted, 2 errors by position', async () => {
  const list = emails(1000, 'batch');
  const badAt = [17, 640];
  const contacts = contactsOf(list).map((c, i) => (badAt.includes(i) ? { ...c, 9999999: 'no such field' } : c));
  const res = await v3(token, 'PUT', '/contact?create_if_not_exists=1', { key_id: String(EMAIL), contacts });
  expect(res.status).toBe(200);
  expect(res.data.ids).toHaveLength(998);
  expect(res.data.errors.map((e: { index: number }) => e.index)).toEqual(badAt);
  expect(res.data.errors.every((e: { code: number }) => e.code === 2011)).toBe(true);

  const valid = list.filter((_, i) => !badAt.includes(i));
  const got = await v3(token, 'POST', '/contact/getdata', { keyId: String(EMAIL), keyValues: [valid[0], valid[997], list[badAt[0]!]], fields: ['3'] });
  expect(got.data.result).toHaveLength(2);
  expect(got.data.errors.map((e: { code: number }) => e.code)).toEqual([2008]);
});

// FR-9
test('3. getdata of 3 emails returns only fields 1 and 3', async () => {
  const list = emails(3, 'gd');
  await upsert(token, list, { 2: 'Apellido' });
  const res = await v3(token, 'POST', '/contact/getdata', { keyId: String(EMAIL), keyValues: list, fields: ['1', '3'] });
  expect(res.status).toBe(200);
  expect(res.data.errors).toEqual([]);
  expect(res.data.result).toHaveLength(3);
  for (const r of res.data.result) {
    expect(Object.keys(r).sort()).toEqual(['1', '3', 'id']);
    expect(list).toContain(r['3']);
    expect(r['1']).toBe('E2E');
  }
});

// FR-10
test('4. search by email in the console and open the contact', async ({ page }) => {
  const [email] = emails(1, 'search');
  await upsert(token, [email!], { 2: 'Buscada' });
  await uiLogin(page, demoAdmin().email, demoAdmin().password);
  await page.goto('/es/contacts');
  await page.locator('#contact-q').fill(email!);
  const row = page.getByRole('region', { name: 'Resultados' }).getByRole('link').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/\/es\/contacts\/[0-9a-f-]{36}$/);
  await expect(page.getByText(email!).first()).toBeVisible();
  await expect(page.getByText('Buscada').first()).toBeVisible();
});

// FR-11
test('5. console import of a 1 M-row CSV with invalid rows finishes unattended and reports each one', async ({ page }) => {
  test.setTimeout(45 * 60_000);
  const rows = Number(process.env.E2E_IMPORT_ROWS ?? 1_000_000);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'oe-e2e-')), 'contacts.csv');
  const bad = await genCsv(file, rows);
  expect(bad.length).toBeGreaterThan(0);

  await uiLogin(page, demoAdmin().email, demoAdmin().password);
  await page.goto('/es/contacts/import');
  await page.locator('#csv-file').setInputFiles(file);
  await page.getByRole('button', { name: 'Subir y continuar' }).click();
  await page.locator('#target-kind').selectOption('contacts');
  await page.locator('#mode').selectOption('upsert');
  await page.locator('#key-id').selectOption(String(EMAIL));
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await page.locator('#map-0').selectOption(String(EMAIL));
  await page.locator('#map-1').selectOption('1');
  await page.locator('#map-2').selectOption('2');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();

  const started = Date.now();
  await page.getByRole('button', { name: 'Iniciar importación' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^(Completado|Fallido)$/ })).toBeVisible({ timeout: 40 * 60_000 });
  const seconds = Math.round((Date.now() - started) / 1000);
  test.info().annotations.push({ type: 'import-duration', description: `${rows} rows in ${seconds} s` });
  console.log(`import of ${rows} rows (${bad.length} invalid) took ${seconds} s`);

  await expect(page.getByRole('status').filter({ hasText: 'Completado' })).toBeVisible();
  const count = (label: string) => page.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd');
  await expect(count('Filas leídas')).toHaveText(String(rows));
  await expect(count('Filas con error')).toHaveText(String(bad.length));
  await expect(count('Filas correctas')).toHaveText(String(rows - bad.length));

  const href = await page.getByRole('link', { name: /Descargar reporte de errores/ }).getAttribute('href');
  const report = await (await fetch(href!)).text();
  for (const i of bad) expect(report, `report lists row ${i}`).toContain(badName(i));
  expect(report.trim().split('\n')).toHaveLength(bad.length + 1);

  const spot = await v3(token, 'POST', '/contact/getdata', { keyId: String(EMAIL), keyValues: [emailOf(1), emailOf(rows)], fields: ['1'] });
  expect(spot.data.result).toHaveLength(2);
});

// FR-12
test('6. export by API -> job_id -> CSV download -> the link expires', async () => {
  const list = emails(5, 'exp');
  await upsert(token, list);
  const { id } = await newList(token, 'export');
  await v3(token, 'POST', `/contactlist/${id}/add`, { key_id: String(EMAIL), external_ids: list });

  const accepted = await v3(token, 'POST', '/export', { fields: ['1', '3'], scope: `list:${id}`, format: 'csv' });
  expect(accepted.status).toBe(202);
  const job = await waitJob(token, accepted.data.job_id);
  expect(job.status).toBe('succeeded');

  const url = new URL(job.result_url);
  const downloaded = await fetch(url);
  expect(downloaded.status).toBe(200);
  const csv = await downloaded.text();
  for (const e of list) expect(csv).toContain(e);

  // The e2e stack must set IMPORTER_EXPORT_URL_TTL to a few seconds (default is 24 h).
  const ttl = Number(url.searchParams.get('X-Amz-Expires'));
  expect(ttl, 'export URL TTL: set IMPORTER_EXPORT_URL_TTL short for e2e').toBeLessThanOrEqual(300);
  const signed = url.searchParams.get('X-Amz-Date')!; // 20260101T120000Z
  const issued = Date.parse(signed.replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/, '$1-$2-$3T$4:$5:$6Z'));
  await sleep(Math.max(0, issued + ttl * 1000 - Date.now()) + 2_000);
  expect((await fetch(url)).status).toBe(403);
});

// FR-13
test('7. add 500 contacts to a list by API and see count 500', async ({ page }) => {
  const list = emails(500, 'l500');
  expect((await upsert(token, list)).data.errors).toEqual([]);
  const { id, name } = await newList(token, 'list500');
  const added = await v3(token, 'POST', `/contactlist/${id}/add`, { key_id: String(EMAIL), external_ids: list });
  expect(added.status).toBe(200);
  expect(await listCount(token, id)).toBe(500);

  await uiLogin(page, demoAdmin().email, demoAdmin().password);
  await page.goto('/es/contacts/lists');
  await expect(page.getByRole('row', { name: new RegExp(name) }).getByRole('cell', { name: '500', exact: true })).toBeVisible();
});

// FR-14
test('8. consent changes show in the contact history', async ({ page }) => {
  const [email] = emails(1, 'consent');
  await upsert(token, [email!]);
  const consent = (value: 1 | 2, text: string) =>
    v3(token, 'POST', '/contact/consent', { key_id: String(EMAIL), key_value: email, channel: 'email', value, source: 'e2e_api', text });
  expect((await consent(1, 'acepto por API')).status).toBe(200);

  await uiLogin(page, demoAdmin().email, demoAdmin().password);
  await page.goto('/es/contacts');
  await page.locator('#contact-q').fill(email!);
  await page.getByRole('region', { name: 'Resultados' }).getByRole('link').first().click();

  await page.locator('#consent-channel').selectOption('email');
  await page.locator('#consent-value').selectOption('2');
  await page.locator('#consent-text').fill('baja desde la consola');
  await page.getByRole('button', { name: 'Registrar cambio' }).click();

  const history = page.getByRole('table', { name: 'Historial de consentimientos' });
  await expect(history.getByRole('row', { name: /acepto por API/ })).toContainText('Acepta');
  await expect(history.getByRole('row', { name: /baja desde la consola/ })).toContainText('No acepta');
  await expect(history.getByRole('row', { name: /e2e_api/ })).toBeVisible();
});

// FR-15
test('9. GDPR export is downloadable and forgetting removes the contact everywhere', async () => {
  const [target, ...others] = emails(4, 'gdpr');
  await upsert(token, [target!, ...others]);
  const { id } = await newList(token, 'gdpr');
  await v3(token, 'POST', `/contactlist/${id}/add`, { key_id: String(EMAIL), external_ids: [target, ...others] });
  const key = { key_id: String(EMAIL), key_value: target };

  const exported = await v3(token, 'POST', '/gdpr/export', key);
  expect(exported.status).toBe(202);
  const exportJob = await waitJob(token, exported.data.job_id);
  expect(exportJob.status).toBe('succeeded');
  const dump = await fetch(exportJob.result_url);
  expect(dump.status).toBe(200);
  expect(await dump.text()).toContain(target);

  const forgotten = await v3(token, 'POST', '/gdpr/forget', key);
  expect(forgotten.status).toBe(202);
  expect((await waitJob(token, forgotten.data.job_id)).status).toBe('succeeded');

  const found = await admin('GET', `/contacts?q=${encodeURIComponent(target!)}`, adminToken);
  expect(found.body.items).toEqual([]);
  const got = await v3(token, 'POST', '/contact/getdata', { keyId: String(EMAIL), keyValues: [target], fields: ['3'] });
  expect(got.data.result).toEqual([]);
  expect(got.data.errors.map((e: { code: number }) => e.code)).toEqual([2008]);
  expect(await listCount(token, id)).toBe(others.length);

  const exp = await v3(token, 'POST', '/export', { fields: ['3'], scope: `list:${id}`, format: 'csv' });
  const job = await waitJob(token, exp.data.job_id);
  const csv = await (await fetch(job.result_url)).text();
  expect(csv).not.toContain(target);
  for (const e of others) expect(csv).toContain(e);
  expect((await v3(token, 'POST', '/gdpr/export', key)).status).toBe(404);
});

// FR-16 (segment filter is covered in F3)
test('10. the "mascotas" relational table shows rows in the contact record', async ({ page }) => {
  await uiLogin(page, demoAdmin().email, demoAdmin().password);
  await page.goto('/es/contacts');
  await page.locator('#contact-q').fill('seed-0001@demo.local');
  await page.getByRole('region', { name: 'Resultados' }).getByRole('link').first().click();
  const panel = page.getByRole('tabpanel');
  await page.getByRole('tab', { name: 'mascotas' }).click();
  await expect(panel).toContainText('Mascota 1');
  await expect(panel).toContainText('perro');
});

// NFR-8
test('11. an API client of tenant A cannot read or write contacts of tenant B', async () => {
  const op = await tokenFor(operator().email, operator().password);
  const bEmail = `${unique('admin')}@tenantb.local`;
  const tenant = await admin('POST', '/tenants', op, {
    name: unique('Tenant B'),
    timezone: 'America/Mexico_City',
    default_locale: 'es',
    admin: { email: bEmail, password: TEST_PASSWORD },
  });
  expect(tenant.status).toBe(201);
  const bAdmin = await tokenFor(bEmail, TEST_PASSWORD);
  const client = await admin('POST', '/api-clients', bAdmin, {
    name: unique('client b'),
    scopes: ['contacts:view', 'contacts:edit', 'contacts:admin', 'jobs:view'],
  });
  expect(client.status).toBe(201);
  const tokenB = await clientToken(client.body.client_id, client.body.client_secret);

  // A's contact (seed) and a list of A.
  const aEmail = 'seed-0002@demo.local';
  const aList = await newList(token, 'tenant-a');
  const bOwn = emails(1, 'b')[0]!;
  expect((await upsert(tokenB, [bOwn])).data.ids).toHaveLength(1);

  // Read: A's contact is not found from B, and B's console search does not list it.
  const read = await v3(tokenB, 'POST', '/contact/getdata', { keyId: String(EMAIL), keyValues: [aEmail, bOwn], fields: ['1', '3'] });
  expect(read.data.result.map((r: Record<string, string>) => r['3'])).toEqual([bOwn]);
  expect(read.data.errors.map((e: { code: number }) => e.code)).toEqual([2008]);
  expect((await admin('GET', `/contacts?q=${encodeURIComponent(aEmail)}`, bAdmin)).body.items).toEqual([]);

  // Write: update without create is 2008; delete is 2008; A's data is untouched.
  const before = (await v3(token, 'POST', '/contact/getdata', { keyId: String(EMAIL), keyValues: [aEmail], fields: ['1'] })).data.result;
  const upd = await v3(tokenB, 'PUT', '/contact', { key_id: String(EMAIL), contacts: [{ [EMAIL]: aEmail, 1: 'hijacked' }] });
  expect(upd.data.errors.map((e: { code: number }) => e.code)).toEqual([2008]);
  const del = await v3(tokenB, 'POST', '/contact/delete', { key_id: String(EMAIL), contacts: [{ [EMAIL]: aEmail }] });
  expect(del.data.errors.map((e: { code: number }) => e.code)).toEqual([2008]);
  expect((await v3(token, 'POST', '/contact/getdata', { keyId: String(EMAIL), keyValues: [aEmail], fields: ['1'] })).data.result).toEqual(before);

  // Lists and GDPR of A are unreachable from B.
  expect((await v3(tokenB, 'GET', `/contactlist/${aList.id}/count`)).status).toBe(404);
  expect((await v3(tokenB, 'POST', `/contactlist/${aList.id}/add`, { key_id: String(EMAIL), external_ids: [bOwn] })).status).toBe(404);
  expect((await v3(tokenB, 'POST', '/gdpr/forget', { key_id: String(EMAIL), key_value: aEmail })).status).toBe(404);
  expect((await v3(token, 'POST', '/contact/getdata', { keyId: String(EMAIL), keyValues: [aEmail], fields: ['3'] })).data.result).toHaveLength(1);
});
