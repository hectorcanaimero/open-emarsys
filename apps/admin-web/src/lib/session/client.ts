import { CSRF_COOKIE, CSRF_HEADER, type AuthResult } from './constants';

/** POSTs JSON to an `/api/auth/*` handler with the double-submit CSRF token. */
export async function postAuth(url: string, body: Record<string, unknown>): Promise<AuthResult> {
  const token = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: token ?? '' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as AuthResult;
  } catch {
    return { error: 'unknown' };
  }
}

/** Message key and values under `auth.errors` for a failed result. */
export function errorMessage(
  t: (key: string, values?: Record<string, string | number>) => string,
  result: Extract<AuthResult, { error: string }>,
  invalidKey = 'errors.invalid'
): string {
  if (result.error === 'invalid') return t(invalidKey);
  if (result.error === 'locked') {
    return t('errors.locked', { minutes: Math.ceil((result.retryAfter ?? 900) / 60) });
  }
  return t(`errors.${result.error}`);
}
