import { trace } from '@opentelemetry/api';
import pino, { type Logger } from 'pino';

export interface LoggerOptions {
  /** Resolves the current tenant, e.g. from `TenantContext` (src/tenant). */
  getTenantId?: () => string | undefined;
  level?: string;
}

/** JSON pino logger that stamps every line with `trace_id` (active OTel span) and `tenant_id`. */
export function createLogger(serviceName: string, options: LoggerOptions = {}): Logger {
  return pino({
    name: serviceName,
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    mixin() {
      const spanContext = trace.getActiveSpan()?.spanContext();
      const tenantId = options.getTenantId?.();
      return {
        ...(spanContext ? { trace_id: spanContext.traceId } : {}),
        ...(tenantId ? { tenant_id: tenantId } : {}),
      };
    },
  });
}
