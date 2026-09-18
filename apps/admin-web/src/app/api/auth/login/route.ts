import type { NextRequest } from 'next/server';
import { createApiClient } from '@/lib/api/client';
import { safeNext } from '@/lib/session/next';
import { authFailure, csrfOk, json, localeOf, setMfaToken, setTokens } from '@/lib/session/server';

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return json({ error: 'csrf' }, 403);

  const body = (await req.json().catch(() => null)) as {
    email?: unknown;
    password?: unknown;
    next?: unknown;
    locale?: unknown;
  } | null;
  if (typeof body?.email !== 'string' || typeof body.password !== 'string') {
    return json({ error: 'invalid' }, 401);
  }
  const locale = localeOf(`/${String(body.locale)}`);

  const { data, response } = await createApiClient().POST('/auth/login', {
    body: { email: body.email, password: body.password },
  });
  if (!data) return authFailure(response);

  if (data.mfa_required) {
    const res = json({ mfa: true });
    setMfaToken(res, data.mfa_token);
    return res;
  }
  const res = json({ next: safeNext(typeof body.next === 'string' ? body.next : null, `/${locale}`) });
  setTokens(res, data);
  return res;
}
