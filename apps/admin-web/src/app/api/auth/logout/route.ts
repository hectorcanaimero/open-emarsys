import type { NextRequest } from 'next/server';
import { createApiClient } from '@/lib/api/client';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/session/constants';
import { clearSession, csrfOk, json, localeOf } from '@/lib/session/server';

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return json({ error: 'csrf' }, 403);

  const body = (await req.json().catch(() => null)) as { locale?: unknown } | null;
  const locale = localeOf(`/${String(body?.locale)}`);
  const access = req.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;

  if (refresh) {
    // Best effort: the cookies are cleared either way.
    await createApiClient()
      .POST('/auth/logout', {
        body: { refresh_token: refresh },
        headers: access ? { authorization: `Bearer ${access}` } : undefined,
      })
      .catch(() => undefined);
  }
  const res = json({ next: `/${locale}/login` });
  clearSession(res);
  return res;
}
