import type { NextRequest } from 'next/server';
import { createApiClient } from '@/lib/api/client';
import { MFA_COOKIE } from '@/lib/session/constants';
import { safeNext } from '@/lib/session/next';
import { authFailure, csrfOk, json, localeOf, setTokens } from '@/lib/session/server';

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return json({ error: 'csrf' }, 403);

  const mfaToken = req.cookies.get(MFA_COOKIE)?.value;
  if (!mfaToken) return json({ error: 'expired' }, 401);

  const body = (await req.json().catch(() => null)) as {
    code?: unknown;
    next?: unknown;
    locale?: unknown;
  } | null;
  if (typeof body?.code !== 'string') return json({ error: 'invalid' }, 401);
  const locale = localeOf(`/${String(body.locale)}`);

  const { data, response } = await createApiClient().POST('/auth/mfa/verify', {
    body: { mfa_token: mfaToken, code: body.code },
  });
  if (!data) return authFailure(response);

  const res = json({ next: safeNext(typeof body.next === 'string' ? body.next : null, `/${locale}`) });
  setTokens(res, data);
  return res;
}
