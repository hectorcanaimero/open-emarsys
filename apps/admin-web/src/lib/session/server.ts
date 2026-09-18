import { NextResponse, type NextRequest } from 'next/server';
import { routing } from '@/i18n/routing';
import {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  MFA_COOKIE,
  MFA_PATH,
  REFRESH_COOKIE,
  REFRESH_PATH,
  type AuthResult,
} from './constants';

const base = {
  httpOnly: true,
  secure: process.env.NODE_ENV !== 'development',
  sameSite: 'lax' as const,
};

export function setTokens(
  res: NextResponse,
  tokens: { access_token: string; refresh_token: string }
) {
  res.cookies.set(ACCESS_COOKIE, tokens.access_token, { ...base, path: '/' });
  res.cookies.set(REFRESH_COOKIE, tokens.refresh_token, { ...base, path: REFRESH_PATH });
  res.cookies.set(MFA_COOKIE, '', { ...base, path: MFA_PATH, maxAge: 0 });
}

export function setMfaToken(res: NextResponse, mfaToken: string) {
  res.cookies.set(MFA_COOKIE, mfaToken, { ...base, path: MFA_PATH, maxAge: 300 });
}

export function clearSession(res: NextResponse) {
  res.cookies.set(ACCESS_COOKIE, '', { ...base, path: '/', maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, '', { ...base, path: REFRESH_PATH, maxAge: 0 });
  res.cookies.set(MFA_COOKIE, '', { ...base, path: MFA_PATH, maxAge: 0 });
}

/** Issues the double-submit token on page responses that do not carry one yet. */
export function ensureCsrfCookie(req: NextRequest, res: NextResponse) {
  if (req.cookies.get(CSRF_COOKIE)?.value) return;
  res.cookies.set(CSRF_COOKIE, crypto.randomUUID(), {
    ...base,
    httpOnly: false,
    path: '/',
  });
}

/** Writes must come from our own origin and echo the CSRF cookie in a header. */
export function csrfOk(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!origin || !host) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const cookie = req.cookies.get(CSRF_COOKIE)?.value;
  return originHost === host && !!cookie && req.headers.get(CSRF_HEADER) === cookie;
}

export function json(body: AuthResult, status = 200) {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/** Maps a core error to what the form shows; 401 never says whether the email exists. */
export function authFailure(response: Response) {
  const retryAfter = Number(response.headers.get('retry-after')) || undefined;
  switch (response.status) {
    case 400:
    case 401:
      return json({ error: 'invalid' }, 401);
    case 423:
      return json({ error: 'locked', retryAfter }, 423);
    case 429:
      return json({ error: 'rate_limited', retryAfter }, 429);
    default:
      return json({ error: 'unknown' }, 502);
  }
}

export function localeOf(path: string): string {
  const segment = path.split('/')[1] ?? '';
  // Not next-intl's `hasLocale`: its entry pulls the node-only request config into the edge bundle.
  return (routing.locales as readonly string[]).includes(segment) ? segment : routing.defaultLocale;
}

export function tokenExpired(jwt: string, skewSeconds = 30): boolean {
  try {
    const payload = jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(payload)) as { exp?: number };
    return typeof exp !== 'number' || exp - skewSeconds <= Date.now() / 1000;
  } catch {
    return true;
  }
}
