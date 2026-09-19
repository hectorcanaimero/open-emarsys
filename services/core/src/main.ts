import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@oe/ts-common/config';
import { startOtel } from '@oe/ts-common/otel';
import { z } from 'zod';
import { AppModule } from './app.module.js';

// Every controller declares its own full path (C11): `/admin/v1/...`,
// `/api/v3/...` or `/internal/v1/...`. There is no single Nest global prefix
// because the three coexist in this one service.
startOtel('core');

export const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  NATS_URL: z.string().min(1),
  CORE_JWT_ISSUER: z.string().min(1).default('open-emarsys/core'),
});
export type CoreConfig = z.infer<typeof configSchema>;

async function bootstrap(): Promise<void> {
  const config = loadConfig(configSchema);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config));
  // Express defaults to 100 kB; `PUT /api/v3/contact` takes up to 1,000 contacts (FR-8).
  app.useBodyParser('json', { limit: '5mb' });
  await app.listen(config.PORT);
}

void bootstrap();
