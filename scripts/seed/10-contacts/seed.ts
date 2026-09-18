// Contacts seed (F1.6.T2, NFR-13). Idempotent: fields, lists and the table are looked up by
// name, contacts and rows are upserted by email / row key. Talks to core over HTTP with the
// demo API client that 00-platform wrote to `.env.local`.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const CORE = process.env.OE_CORE_URL ?? 'http://localhost:3001';
const CONTACTS = 1000;
const EMAIL_FIELD = '3';
const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const COUNTRIES = ['Brasil', 'Argentina', 'Chile', 'México', 'Colombia', 'España'];

/** `run.sh` sources `.env.local` before 00-platform creates the client, so read it again. */
function clientCredentials(): { id: string; secret: string } {
  const file = path.join(root, '.env.local');
  const local = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const get = (k: string) => process.env[k] || new RegExp(`^${k}=(.+)$`, 'm').exec(local)?.[1];
  const id = get('OE_DEMO_CLIENT_ID');
  const secret = get('OE_DEMO_CLIENT_SECRET');
  if (!id || !secret) throw new Error('OE_DEMO_CLIENT_ID/SECRET missing: run scripts/seed/00-platform first');
  return { id, secret };
}

async function token(): Promise<string> {
  const { id, secret } = clientCredentials();
  const res = await fetch(`${CORE}/api/v3/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`token -> ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

let bearer = '';
async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CORE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}
/** Public v3 calls come wrapped in `{replyCode, data}`. */
const v3 = async <T>(method: string, p: string, body?: unknown): Promise<T> => (await api<{ data: T }>(method, `/api/v3${p}`, body)).data;

interface Field {
  id: number;
  string_id: string;
}

async function ensureFields(): Promise<Record<string, number>> {
  const defs = [
    { name: 'País de interés', string_id: 'pais_interes', application_type: 'text' },
    { name: 'Talle', string_id: 'talle', application_type: 'single_choice', choices: SIZES },
    { name: 'Fecha de última compra', string_id: 'fecha_ultima_compra', application_type: 'date' },
  ];
  const have = await v3<Field[]>('GET', '/field');
  const ids: Record<string, number> = {};
  for (const d of defs) {
    const found = have.find((f) => f.string_id === d.string_id);
    ids[d.string_id] = found ? found.id : (await v3<Field>('POST', '/field', d)).id;
  }
  return ids;
}

const emailOf = (i: number) => `seed-${String(i).padStart(4, '0')}@demo.local`;

async function upsertContacts(f: Record<string, number>): Promise<void> {
  const sizes = await v3<{ id: number; choice: string }[]>('GET', `/field/${f.talle}/choice`);
  const contacts = Array.from({ length: CONTACTS }, (_, i) => ({
    1: `Contacto ${i + 1}`,
    2: 'Demo',
    [EMAIL_FIELD]: emailOf(i + 1),
    [f.pais_interes!]: COUNTRIES[i % COUNTRIES.length],
    [f.talle!]: sizes[i % sizes.length]!.id,
    [f.fecha_ultima_compra!]: new Date(Date.UTC(2026, 0, 1) + (i % 240) * 86_400_000).toISOString().slice(0, 10),
  }));
  const r = await v3<{ ids: string[]; errors: unknown[] }>('PUT', '/contact?create_if_not_exists=1', {
    key_id: EMAIL_FIELD,
    contacts,
  });
  if (r.errors.length) throw new Error(`contact upsert errors: ${JSON.stringify(r.errors.slice(0, 3))}`);
  console.log(`upserted ${r.ids.length} contacts`);
}

async function ensureLists(): Promise<void> {
  const lists = await v3<{ id: number | string; name: string }[]>('GET', '/contactlist');
  const specs = [
    { name: 'Clientes recientes', pick: (i: number) => i <= 500 },
    { name: 'Clientes de talle par', pick: (i: number) => i % 2 === 0 },
  ];
  for (const s of specs) {
    const emails = Array.from({ length: CONTACTS }, (_, i) => i + 1).filter(s.pick).map(emailOf);
    const found = lists.find((l) => l.name === s.name);
    const id = found ? found.id : (await v3<{ id: number | string }>('POST', '/contactlist', { name: s.name })).id;
    // Adding an existing member is a no-op, so reruns do not duplicate.
    await v3('POST', `/contactlist/${id}/add`, { key_id: EMAIL_FIELD, external_ids: emails });
    const { count } = await v3<{ count: number }>('GET', `/contactlist/${id}/count`);
    console.log(`list "${s.name}": ${count} members`);
  }
}

async function ensurePets(): Promise<void> {
  const tables = await api<{ id: string; name: string }[] | { items: { id: string; name: string }[] }>('GET', '/admin/v1/relational-tables');
  const found = (Array.isArray(tables) ? tables : tables.items).find((t) => t.name === 'mascotas');
  const id =
    found?.id ??
    (
      await api<{ id: string }>('POST', '/admin/v1/relational-tables', {
        name: 'mascotas',
        key_field: 'nombre',
        columns: [
          { name: 'nombre', type: 'text' },
          { name: 'especie', type: 'text' },
          { name: 'edad', type: 'number' },
        ],
      })
    ).id;
  const rows = Array.from({ length: 100 }, (_, i) => ({
    key_value: emailOf(i + 1),
    row_key: `mascota-${i + 1}`,
    data: { nombre: `Mascota ${i + 1}`, especie: i % 2 ? 'gato' : 'perro', edad: (i % 15) + 1 },
  }));
  await v3('PUT', `/relational/${id}/rows`, { key_id: EMAIL_FIELD, rows });
  console.log(`relational table "mascotas": ${rows.length} rows`);
}

async function main(): Promise<void> {
  bearer = await token();
  const fields = await ensureFields();
  await upsertContacts(fields);
  await ensureLists();
  await ensurePets();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
