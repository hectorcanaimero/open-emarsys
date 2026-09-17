import 'reflect-metadata';
import {
  Controller,
  Get,
  Module,
  NotFoundException,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicApiError, PublicEnvelopeFilter, PublicEnvelopeInterceptor } from './envelope.js';
import { ProblemJsonFilter } from './problem-json.filter.js';

@Controller('admin/v1/widgets')
@UseFilters(ProblemJsonFilter)
class AdminWidgetsController {
  @Get('missing')
  missing(): never {
    throw new NotFoundException('widget not found');
  }
}

@Controller('api/v3/widgets')
@UseInterceptors(PublicEnvelopeInterceptor)
@UseFilters(PublicEnvelopeFilter)
class PublicWidgetsController {
  @Get()
  list() {
    return { items: [{ id: '1' }] };
  }

  @Get('boom')
  boom(): never {
    throw new PublicApiError(1001, 'Invalid key field id');
  }
}

@Module({ controllers: [AdminWidgetsController, PublicWidgetsController] })
class TestAppModule {}

describe('http error formats (test Nest app)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(TestAppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('formats /admin/v1 errors as RFC 9457 problem+json (C3)', async () => {
    const res = await request(app.getHttpServer()).get('/admin/v1/widgets/missing');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'widget not found',
      instance: '/admin/v1/widgets/missing',
    });
  });

  it('wraps successful /api/v3 responses in the envelope (C2)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v3/widgets');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ replyCode: 0, replyText: 'OK', data: { items: [{ id: '1' }] } });
  });

  it('wraps business errors in the envelope with a non-zero replyCode (C2)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v3/widgets/boom');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ replyCode: 1001, replyText: 'Invalid key field id', data: null });
  });
});
