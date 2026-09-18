import { NextResponse, type NextRequest } from 'next/server';
import { createApiClient } from '@/lib/api/client';
import { REFRESH_COOKIE } from '@/lib/session/constants';
import { safeNext } from '@/lib/session/next';
import { clearSession, localeOf, setTokens } from '@/lib/session/server';

/**
 * The middleware sends expired sessions here with a top-level GET, because the refresh
 * cookie is scoped to `/api/auth` and never reaches page requests. Rotates the pair and
 * returns to `next`, or to the login page when the refresh token is gone or rejected.
 */
export async function GET(req: NextRequest) {
  const next = safeNext(req.nextUrl.searchParams.get('next'), '/');
  const locale = localeOf(next);
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;

  const { data } = refreshToken
    ? await createApiClient().POST('/auth/refresh', { body: { refresh_token: refreshToken } })
    : { data: undefined };

  if (!data) {
    const login = new URL(`/${locale}/login`, req.url);
    login.searchParams.set('next', next);
    const res = NextResponse.redirect(login);
    clearSession(res);
    return res;
  }
  const res = NextResponse.redirect(new URL(next, req.url));
  setTokens(res, data);
  return res;
}
