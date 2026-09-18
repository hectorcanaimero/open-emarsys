import { createApiClient } from '@/lib/api/client';
import type { Tenant, TenantCreateDto, TenantUpdateDto } from './schema';

export class TenantApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

// Created per call, not once at module scope: openapi-fetch resolves `fetch` from
// `globalThis.fetch` at client-creation time, so a module-scoped singleton would pin
// the client to whatever `fetch` existed at import time — before MSW patches it in tests.
function client() {
  return createApiClient();
}

function unwrap<T>({
  data,
  error,
}: {
  data?: T;
  error?: { title?: string; detail?: string; status?: number };
}): T {
  if (error) {
    throw new TenantApiError(error.detail ?? error.title ?? 'request_failed', error.status);
  }
  if (data === undefined) {
    throw new TenantApiError('request_failed');
  }
  return data;
}

export async function listTenants(cursor?: string) {
  const result = await client().GET('/tenants', { params: { query: { cursor, limit: 50 } } });
  return unwrap(result);
}

export async function createTenant(payload: TenantCreateDto) {
  const result = await client().POST('/tenants', { body: payload });
  return unwrap<Tenant>(result);
}

export async function updateTenant(id: string, payload: TenantUpdateDto) {
  const result = await client().PATCH('/tenants/{id}', { params: { path: { id } }, body: payload });
  return unwrap<Tenant>(result);
}
