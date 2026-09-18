// Platform seed (F0.8.T3, NFR-13). Idempotent: every step checks before it creates.
// Talks to core over HTTP; only the operator bootstrap goes through the core CLI.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const ENV_LOCAL = path.join(root, '.env.local');
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing env var ${name} (see deploy/compose/.env.example)`);
  return value;
};

const CORE = process.env.OE_CORE_URL ?? 'http://localhost:3001';
const MAILPIT = process.env.OE_MAILPIT_URL ?? 'http://localhost:8025';
const TENANT_NAME = 'Tienda Demo';
const CLIENT_NAME = 'Demo API client';

const DEMO_USERS = [
  { email: 'marketer@demo.local', role: 'Marketer', password: env('OE_DEMO_MARKETER_PASSWORD') },
  { email: 'viewer@demo.local', role: 'Viewer', password: env('OE_DEMO_VIEWER_PASSWORD') },
];

async function api<T>(method: string, url: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}
const admin = <T>(method: string, p: string, token?: string, body?: unknown) =>
  api<T>(method, `${CORE}/admin/v1${p}`, { token, body });

async function listAll<T>(p: string, token: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: T[]; next_cursor: string | null } = await admin(
      'GET',
      `${p}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      token
    );
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

const login = async (email: string, password: string) =>
  (await admin<{ access_token: string }>('POST', '/auth/login', undefined, { email, password })).access_token;

function createOperator(): void {
  const databaseUrl =
    process.env.DATABASE_URL ??
    `postgres://core:${env('OE_PG_CORE_PASSWORD')}@localhost:${process.env.OE_PG_PORT ?? '5432'}/${env('OE_PG_DB')}?schema=identity`;
  execFileSync(
    'pnpm',
    ['--filter', '@oe/core', 'cli', 'create-operator', '--email', env('OE_OPERATOR_EMAIL'), '--password', env('OE_OPERATOR_PASSWORD')],
    { cwd: root, stdio: 'inherit', env: { ...process.env, DATABASE_URL: databaseUrl } }
  );
}

/** Reads the newest invitation mail for `email` from Mailpit and returns its `/invite/<token>`. */
async function inviteToken(email: string): Promise<string> {
  const found = await api<{ messages: { ID: string }[] }>(
    'GET',
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`
  );
  const id = found.messages[0]?.ID;
  if (!id) throw new Error(`no invitation mail for ${email} in Mailpit`);
  const msg = await api<{ Text: string }>('GET', `${MAILPIT}/api/v1/message/${id}`);
  const match = /\/invite\/([^\s"<]+)/.exec(msg.Text);
  if (!match) throw new Error(`invitation mail for ${email} has no link`);
  return match[1]!;
}

/** Upserts KEY=VALUE lines in the gitignored `.env.local`. */
function writeEnvLocal(values: Record<string, string>): void {
  const lines = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, 'utf8').split('\n').filter(Boolean) : [];
  const kept = lines.filter((l) => !Object.keys(values).some((k) => l.startsWith(`${k}=`)));
  writeFileSync(ENV_LOCAL, [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n');
}

async function main(): Promise<void> {
  createOperator();
  const operator = await login(env('OE_OPERATOR_EMAIL'), env('OE_OPERATOR_PASSWORD'));

  const tenants = await listAll<{ id: string; name: string }>('/tenants', operator);
  if (tenants.some((t) => t.name === TENANT_NAME)) {
    console.log(`tenant "${TENANT_NAME}" already exists`);
  } else {
    await admin('POST', '/tenants', operator, {
      name: TENANT_NAME,
      timezone: 'America/Sao_Paulo',
      default_locale: 'es',
      admin: { email: 'admin@demo.local', password: env('OE_DEMO_ADMIN_PASSWORD') },
    });
    console.log(`created tenant "${TENANT_NAME}" with admin@demo.local`);
  }

  const token = await login('admin@demo.local', env('OE_DEMO_ADMIN_PASSWORD'));
  const roles = await listAll<{ id: string; name: string; permissions: { module: string; action: string }[] }>(
    '/roles',
    token
  );
  const users = await listAll<{ email: string; status: string }>('/users', token);

  for (const u of DEMO_USERS) {
    const existing = users.find((x) => x.email.toLowerCase() === u.email);
    if (existing?.status === 'active') continue;
    if (!existing) {
      const role = roles.find((r) => r.name === u.role);
      if (!role) throw new Error(`role ${u.role} not found`);
      await admin('POST', '/users/invitations', token, { email: u.email, role_ids: [role.id], locale: 'es' });
    }
    await admin('POST', `/invitations/${await inviteToken(u.email)}/accept`, undefined, {
      name: u.role,
      password: u.password,
    });
    console.log(`created ${u.email}`);
  }

  // The secret is returned once: keep the client only while `.env.local` still holds its secret.
  const clients = await listAll<{ id: string; name: string; status: string }>('/api-clients', token);
  const active = clients.find((c) => c.name === CLIENT_NAME && c.status === 'active');
  const haveSecret = existsSync(ENV_LOCAL) && /^OE_DEMO_CLIENT_SECRET=./m.test(readFileSync(ENV_LOCAL, 'utf8'));
  if (active && haveSecret) return void console.log('demo API client already exists');
  if (active) await admin('POST', `/api-clients/${active.id}/revoke`, token);
  const adminRole = roles.find((r) => r.name === 'Admin')!;
  const created = await admin<{ client_id: string; client_secret: string }>('POST', '/api-clients', token, {
    name: CLIENT_NAME,
    scopes: adminRole.permissions.map((p) => `${p.module}:${p.action}`),
  });
  writeEnvLocal({ OE_DEMO_CLIENT_ID: created.client_id, OE_DEMO_CLIENT_SECRET: created.client_secret });
  console.log('created demo API client; credentials written to .env.local');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
