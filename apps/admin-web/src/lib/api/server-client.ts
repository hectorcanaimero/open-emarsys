import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from '@/lib/session/constants';
import { createApiClient } from './client';

/** Server-component client: core only accepts Bearer, so it sends the session's access token. */
export async function createServerApiClient() {
  const cookieStore = await cookies();
  return createApiClient(cookieStore.get(ACCESS_COOKIE)?.value);
}
