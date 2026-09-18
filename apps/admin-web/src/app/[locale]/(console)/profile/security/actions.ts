'use server';

import { cookies } from 'next/headers';
import QRCode from 'qrcode';
import { createApiClient } from '@/lib/api/client';
import { ACCESS_COOKIE } from '@/lib/session/constants';

// Server actions get Next's own Origin/Host check, so they need no double-submit token.

export type ActionState =
  | { status: 'idle' | 'ok' }
  | { status: 'error'; error: 'invalidCode' | 'mfaAlreadyEnabled' | 'mfaNotEnabled' | 'unknown' };

export type EnrollState =
  | { status: 'idle' }
  | { status: 'pending'; qr: string; secret: string }
  | Extract<ActionState, { status: 'error' }>;

async function auth() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  return { authorization: `Bearer ${token ?? ''}` };
}

export async function enrollMfa(): Promise<EnrollState> {
  const { data, response } = await createApiClient().POST('/me/mfa/enroll', {
    headers: await auth(),
  });
  if (!data) {
    return { status: 'error', error: response.status === 409 ? 'mfaAlreadyEnabled' : 'unknown' };
  }
  return { status: 'pending', qr: await QRCode.toDataURL(data.otpauth_uri), secret: data.secret };
}

export async function confirmMfa(_prev: ActionState, form: FormData): Promise<ActionState> {
  const { response } = await createApiClient().POST('/me/mfa/confirm', {
    headers: await auth(),
    body: { code: String(form.get('code') ?? '') },
  });
  if (response.ok) return { status: 'ok' };
  return { status: 'error', error: response.status === 400 ? 'invalidCode' : 'unknown' };
}

export async function disableMfa(_prev: ActionState, form: FormData): Promise<ActionState> {
  const { response } = await createApiClient().DELETE('/me/mfa', {
    headers: await auth(),
    body: { code: String(form.get('code') ?? '') },
  });
  if (response.ok) return { status: 'ok' };
  const error = ({ 400: 'invalidCode', 404: 'mfaNotEnabled' } as const)[response.status as 400 | 404];
  return { status: 'error', error: error ?? 'unknown' };
}

export async function updateLocale(_prev: ActionState, form: FormData): Promise<ActionState> {
  const locale = form.get('locale');
  if (locale !== 'es' && locale !== 'pt' && locale !== 'en') return { status: 'error', error: 'unknown' };
  const { response } = await createApiClient().PATCH('/me', {
    headers: await auth(),
    body: { locale },
  });
  return response.ok ? { status: 'ok' } : { status: 'error', error: 'unknown' };
}
