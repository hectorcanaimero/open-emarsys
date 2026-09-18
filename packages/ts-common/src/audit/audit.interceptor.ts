import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Principal } from '../auth/verifier.js';
import { AuditSink } from './types.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUDITED_PREFIXES = ['/admin/v1', '/api/v3'];

interface AuditableRequest {
  method: string;
  url?: string;
  originalUrl?: string;
  params?: Record<string, string>;
  body?: unknown;
  principal?: Principal;
}

function actionOf(method: string): 'create' | 'update' | 'delete' {
  if (method === 'POST') return 'create';
  if (method === 'DELETE') return 'delete';
  return 'update';
}

/** First path segment after `/admin/v1` or `/api/v3`, or `undefined` outside both. */
function resourceTypeOf(path: string): string | undefined {
  const prefix = AUDITED_PREFIXES.find((p) => path.startsWith(p));
  if (!prefix) return undefined;
  return path.slice(prefix.length).split('?')[0]?.split('/').filter(Boolean)[0];
}

/** Unwraps the C2 public envelope (`{replyCode, replyText, data}`), if present. */
function unwrap(response: unknown): unknown {
  if (response && typeof response === 'object' && 'replyCode' in response && 'data' in response) {
    return (response as { data: unknown }).data;
  }
  return response;
}

function idOf(value: unknown): string | null {
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  }
  return null;
}

/**
 * Records every successful write (POST/PUT/PATCH/DELETE) under `/admin/v1`
 * or `/api/v3` via the configured `AuditSink` (FR-6). Reads and error
 * responses are never audited: `tap` only runs on a value, not on an error.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(AuditSink) private readonly sink: AuditSink) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuditableRequest>();
    if (!WRITE_METHODS.has(req.method)) return next.handle();

    const resourceType = resourceTypeOf(req.originalUrl ?? req.url ?? '');
    if (!resourceType) return next.handle();

    return next.handle().pipe(tap((response) => void this.record(req, resourceType, response)));
  }

  private async record(req: AuditableRequest, resourceType: string, response: unknown): Promise<void> {
    const principal = req.principal;
    if (!principal) return;

    const resourceId = req.params?.id ?? idOf(unwrap(response));

    await this.sink.record({
      tenant_id: principal.tenant_id,
      actor_type: principal.typ,
      actor_id: principal.sub,
      action: `${resourceType}.${actionOf(req.method)}`,
      resource_type: resourceType,
      resource_id: resourceId,
      diff: req.method === 'DELETE' ? null : (req.body ?? null),
      at: new Date().toISOString(),
    });
  }
}
