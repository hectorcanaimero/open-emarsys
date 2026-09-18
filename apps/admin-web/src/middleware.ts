import { NextResponse, type NextRequest } from 'next/server';
import createIntlMiddleware from 'next-intl/middleware';
import { routing } from '@/i18n/routing';
import { ACCESS_COOKIE } from '@/lib/session/constants';
import { ensureCsrfCookie, localeOf, tokenExpired } from '@/lib/session/server';

const intl = createIntlMiddleware(routing);

/** Pages of the `(auth)` group; every other localized page belongs to `(console)`. */
const PUBLIC_PAGES = ['login', 'mfa', 'invite'];

export function middleware(req: NextRequest) {
  const res = intl(req);
  ensureCsrfCookie(req, res);
  // next-intl is redirecting to a localized URL; the next request gets checked.
  if (res.headers.has('location')) return res;

  const { pathname, search } = req.nextUrl;
  const [, , page] = pathname.split('/');
  if (page && PUBLIC_PAGES.includes(page)) return res;

  const locale = localeOf(pathname);
  const next = pathname + search;
  const access = req.cookies.get(ACCESS_COOKIE)?.value;

  if (!access) {
    const login = new URL(`/${locale}/login`, req.url);
    login.searchParams.set('next', next);
    return NextResponse.redirect(login);
  }
  // ponytail: two tabs refreshing at once can reuse the single-use token and end the
  // session (core revokes on reuse); add a short-lived refresh lock if that shows up.
  if (tokenExpired(access) && !req.headers.has('next-router-prefetch')) {
    const refresh = new URL('/api/auth/refresh', req.url);
    refresh.searchParams.set('next', next);
    return NextResponse.redirect(refresh);
  }
  return res;
}

export const config = {
  // Pages only: API routes, Next internals and files with an extension are skipped.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
