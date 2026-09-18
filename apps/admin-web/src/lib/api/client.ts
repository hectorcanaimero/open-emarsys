import createClient from 'openapi-fetch';
import type { paths } from '@oe/ts-contracts/openapi/identity';

const baseUrl = process.env.ADMIN_API_URL ?? 'http://localhost:8080/admin/v1';

/** Typed `/admin/v1` client. Pass the session cookie header when calling from server components. */
export function createApiClient(cookieHeader?: string) {
  return createClient<paths>({
    baseUrl,
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });
}
