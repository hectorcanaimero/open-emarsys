import createClient from 'openapi-fetch';
import type { paths } from '@oe/ts-contracts/openapi/identity';
import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/session/constants';

/** Server side: straight to core over the internal network. */
const SERVER_BASE = process.env.ADMIN_API_URL ?? 'http://localhost:8080/admin/v1';
/**
 * Browser side: the same-origin proxy in src/app/api/admin/[...path]. The session JWT lives in
 * an httpOnly cookie that browser code cannot read, and core only accepts a Bearer header.
 */
const BROWSER_BASE = '/api/admin';

const csrfToken = () =>
  document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1) ?? '';

/**
 * Typed `/admin/v1` client. On the server, pass the session's access token; in the browser,
 * calls go through the proxy, which adds it from the cookie, with the CSRF token attached.
 */
export function createApiClient(accessToken?: string) {
  if (typeof window !== 'undefined') {
    // Absolute: openapi-fetch builds a Request, and not every Request accepts a relative URL.
    const client = createClient<paths>({ baseUrl: new URL(BROWSER_BASE, window.location.origin).toString() });
    client.use({
      onRequest({ request }) {
        request.headers.set(CSRF_HEADER, csrfToken());
        return request;
      },
    });
    return client;
  }
  return createClient<paths>({
    baseUrl: SERVER_BASE,
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
  });
}
