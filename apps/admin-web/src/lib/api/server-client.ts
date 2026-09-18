import { cookies } from 'next/headers';
import { createApiClient } from './client';

/** Server-component client that forwards the caller's session cookie to the gateway. */
export async function createServerApiClient() {
  const cookieStore = await cookies();
  return createApiClient(cookieStore.toString());
}
