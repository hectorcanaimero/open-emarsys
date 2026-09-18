import { createHmac, randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing env var ${name} (see deploy/compose/.env.example)`);
  return value;
};

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
export const MAILPIT = process.env.OE_MAILPIT_URL ?? 'http://localhost:8025';
export const demoAdmin = () => ({ email: 'admin@demo.local', password: env('OE_DEMO_ADMIN_PASSWORD') });
export const operator = () => ({ email: env('OE_OPERATOR_EMAIL'), password: env('OE_OPERATOR_PASSWORD') });
/** Meets the 12-character minimum; used for users the tests create. */
export const TEST_PASSWORD = 'e2e-Passw0rd-long';

export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Res<T = any> {
  status: number;
  body: T;
}

const safeJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** fetch + JSON. The gateway allows 10 logins/min/IP, so a 429 is waited out (up to ~1 min). */
export async function http<T = any>(
  method: string,
  url: string,
  opts: { token?: string; json?: unknown; form?: Record<string, string> } = {}
): Promise<Res<T>> {
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.json !== undefined) headers['content-type'] = 'application/json';
    if (opts.form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(url, {
      method,
      headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.form ? new URLSearchParams(opts.form) : undefined,
    });
    if (res.status === 429 && attempt < 10) {
      await sleep(7_000);
      continue;
    }
    const text = await res.text();
    return { status: res.status, body: (text ? safeJson(text) : undefined) as T };
  }
}

export const admin = <T = any>(method: string, path: string, token?: string, json?: unknown) =>
  http<T>(method, `${BASE}/admin/v1${path}`, { token, json });

export const login = (email: string, password: string) => admin('POST', '/auth/login', undefined, { email, password });

export async function tokenFor(email: string, password: string): Promise<string> {
  const res = await login(email, password);
  expect(res.status, `login ${email}`).toBe(200);
  return res.body.access_token;
}

export async function roleIds(token: string): Promise<Record<string, string>> {
  const res = await admin('GET', '/roles?limit=200', token);
  return Object.fromEntries(res.body.items.map((r: { name: string; id: string }) => [r.name, r.id]));
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret. */
export function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** A code different from `previous`, so a replay guard on the used one can't reject it. */
export async function nextTotp(secret: string, previous?: string): Promise<string> {
  for (;;) {
    const code = totp(secret);
    if (code !== previous) return code;
    await sleep(1_000);
  }
}

/** Newest invitation mail for `email` from Mailpit -> the `/invite/<token>` token. */
export async function inviteToken(email: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const found = await http<{ messages?: { ID: string }[] }>(
      'GET',
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`
    );
    const id = found.body.messages?.[0]?.ID;
    if (id) {
      const msg = await http<{ Text: string }>('GET', `${MAILPIT}/api/v1/message/${id}`);
      const match = /\/invite\/([^\s"<]+)/.exec(msg.body.Text);
      if (match) return match[1]!;
    }
    await sleep(1_000);
  }
  throw new Error(`no invitation mail for ${email} in Mailpit`);
}

export interface CreatedUser {
  id: string;
  email: string;
  password: string;
}

/** Invites a new user with `role` in the demo tenant and accepts the invitation through the API. */
export async function createUser(adminToken: string, prefix: string, role = 'Viewer'): Promise<CreatedUser> {
  const email = `${unique(prefix)}@demo.local`;
  const roles = await roleIds(adminToken);
  const invited = await admin('POST', '/users/invitations', adminToken, { email, role_ids: [roles[role]] });
  expect(invited.status).toBe(201);
  const token = await inviteToken(email);
  const accepted = await admin('POST', `/invitations/${token}/accept`, undefined, { name: prefix, password: TEST_PASSWORD });
  expect(accepted.status).toBe(200);
  return { id: accepted.body.id, email, password: TEST_PASSWORD };
}

/**
 * Submits the console login form, waiting out the gateway's per-IP login limit (admin-web calls
 * core from one IP). Resolves once the page reaches `expectUrl` or shows any other outcome.
 */
/**
 * role="alert" elements the app renders. Next keeps an always-present, empty
 * `#__next-route-announcer__` with role="alert" in every page, so a bare
 * getByRole('alert') matches it too and resolves before any real alert shows up.
 */
export const alerts = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

export async function uiLogin(page: Page, email: string, password: string, expectUrl: RegExp = /\/es\/?$/) {
  await page.goto('/es/login');
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    const limited = alerts(page).filter({ hasText: 'Demasiados intentos' });
    const other = alerts(page).filter({ hasNotText: 'Demasiados intentos' });
    await Promise.race([page.waitForURL(expectUrl), limited.waitFor(), other.waitFor()]).catch(() => undefined);
    if (!(await limited.isVisible())) return;
    await sleep(7_000);
  }
}
