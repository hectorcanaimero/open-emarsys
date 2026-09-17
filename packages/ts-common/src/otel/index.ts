import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * Starts the OTel Node SDK. Must be called before `NestFactory.create` so
 * auto-instrumentation can patch modules (http, pg, etc.) before they load.
 */
export function startOtel(serviceName: string): NodeSDK {
  process.env.OTEL_SERVICE_NAME ??= serviceName;

  const sdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
  return sdk;
}
