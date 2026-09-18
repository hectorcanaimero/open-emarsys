'use server';

import { createApiClient } from '@/lib/api/client';

export type InviteState =
  | { status: 'idle' | 'ok' }
  | { status: 'error'; error: 'mismatch' | 'invalid' | 'inviteExpired' | 'inviteNotFound' | 'rate_limited' | 'unknown' };

export async function acceptInvitation(
  token: string,
  _prev: InviteState,
  form: FormData
): Promise<InviteState> {
  const name = String(form.get('name') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (password !== form.get('confirmPassword')) return { status: 'error', error: 'mismatch' };

  const { data, response } = await createApiClient().POST('/invitations/{token}/accept', {
    params: { path: { token } },
    body: { name, password },
  });
  if (data) return { status: 'ok' };
  const error =
    ({ 400: 'invalid', 404: 'inviteNotFound', 410: 'inviteExpired', 429: 'rate_limited' } as const)[
      response.status as 400 | 404 | 410 | 429
    ] ?? 'unknown';
  return { status: 'error', error };
}
