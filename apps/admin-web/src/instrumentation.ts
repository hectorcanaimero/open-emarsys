import { registerOTel } from '@vercel/otel';

/** NFR-12: traces go to the OTel collector (OTEL_EXPORTER_OTLP_ENDPOINT) like core's. */
export function register() {
  registerOTel({ serviceName: 'admin-web' });
}
