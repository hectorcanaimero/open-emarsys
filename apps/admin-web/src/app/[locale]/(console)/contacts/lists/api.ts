import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/session/constants';

// ponytail: hand-written types for the lists slice of admin-v1/contacts.yaml; swap for the
// generated `@oe/ts-contracts/openapi/contacts` once createApiClient is typed for it.
export interface ContactList {
  id: string;
  name: string;
  description: string | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}
export type FieldValues = Record<string, string | number | boolean | null>;
export interface ListMember {
  contact_id: string;
  added_at: string;
  fields: FieldValues;
}
export interface Contact {
  id: string;
  fields: FieldValues;
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

const csrf = () =>
  document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1) ?? '';

/** Calls `/admin/v1` through the same-origin proxy; `data` is undefined on errors and 204s. */
export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}
): Promise<{ ok: boolean; status: number; data?: T }> {
  const url = new URL(`/api/admin${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      [CSRF_HEADER]: csrf(),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.ok && res.status !== 204 ? ((await res.json()) as T) : undefined;
  return { ok: res.ok, status: res.status, data };
}

export const fullName = (f: FieldValues) => [f['1'], f['2']].filter(Boolean).join(' ');
export const contactLabel = (f: FieldValues) => fullName(f) || String(f['3'] ?? '');
