import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storage = new AsyncLocalStorage<string>();

export class MissingTenantError extends Error {
  constructor() {
    super('no tenant in context: wrap the call in TenantContext.run() or withSystemScope()');
    this.name = 'MissingTenantError';
  }
}

export const TenantContext = {
  /** Runs `fn` with `tenantId` as the current tenant for everything it awaits. */
  run<T>(tenantId: string, fn: () => T): T {
    if (!UUID.test(tenantId)) throw new Error(`invalid tenant id: ${tenantId}`);
    return storage.run(tenantId, fn);
  },
  current(): string | undefined {
    return storage.getStore();
  },
};

export function requireTenant(): string {
  const tenantId = storage.getStore();
  if (!tenantId) throw new MissingTenantError();
  return tenantId;
}

/**
 * Sets the tenant from the principal (`request.user.tenant_id`, JwtClaims) on HTTP,
 * or from the event envelope (`tenant_id`) on RPC/NATS handlers. Principals without a
 * tenant (operator, cross-tenant service) pass through with no tenant in context.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const source =
      context.getType() === 'http'
        ? context.switchToHttp().getRequest<{ user?: { tenant_id?: string | null } }>().user
        : context.switchToRpc().getData<{ tenant_id?: string | null }>();
    const tenantId = source?.tenant_id;
    if (!tenantId) return next.handle();
    return new Observable((subscriber) =>
      TenantContext.run(tenantId, () => next.handle().subscribe(subscriber))
    );
  }
}
