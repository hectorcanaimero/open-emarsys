import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/session/constants';

// ponytail: hand-written types for the fields slice of admin-v1/contacts.yaml; swap for the
// generated `@oe/ts-contracts/openapi/contacts` once createApiClient is typed for it.
export const LOCALES = ['es', 'pt', 'en'] as const;
export type Labels = Record<(typeof LOCALES)[number], string>;
export type FieldType = 'text' | 'number' | 'date' | 'boolean' | 'single_choice' | 'multi_choice';
export interface FieldChoice {
  id?: number;
  api_name: string;
  labels: Labels;
}
export interface Field {
  field_id: number;
  api_name: string;
  type: FieldType;
  labels: Labels;
  choices: (FieldChoice & { id: number })[];
  unique: boolean;
  read_only: boolean;
  is_system: boolean;
  deleted_at: string | null;
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
  body?: unknown
): Promise<{ ok: boolean; status: number; data?: T }> {
  const res = await fetch(new URL(`/api/admin${path}`, window.location.origin), {
    method,
    headers: {
      [CSRF_HEADER]: csrf(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.ok && res.status !== 204 ? ((await res.json()) as T) : undefined;
  return { ok: res.ok, status: res.status, data };
}
