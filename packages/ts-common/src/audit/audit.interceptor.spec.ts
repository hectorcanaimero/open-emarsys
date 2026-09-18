import 'reflect-metadata';
import {
  BadRequestException,
  type CanActivate,
  Controller,
  Delete,
  type ExecutionContext,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../auth/verifier.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditSink } from './types.js';

const principal: Principal = {
  sub: 'user-1',
  typ: 'user',
  tenant_id: 'tenant-1',
  perms: ['contacts:edit'],
  iat: 0,
  exp: 0,
};

@Injectable()
class FakePrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    (ctx.switchToHttp().getRequest() as { principal?: Principal }).principal = principal;
    return true;
  }
}

const record = vi.fn().mockResolvedValue(undefined);

class FakeAuditSink extends AuditSink {
  record = record;
}

@Controller('admin/v1/contacts')
@UseInterceptors(AuditInterceptor)
class ContactsController {
  @Get()
  list() {
    return { items: [] };
  }

  @Get('boom')
  boom(): never {
    throw new NotFoundException('nope');
  }

  @Post('boom')
  createBoom(): never {
    throw new BadRequestException('invalid');
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return { id };
  }

  @Post()
  create() {
    return { id: 'c-1' };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return { id };
  }
}

@Module({
  controllers: [ContactsController],
  providers: [{ provide: APP_GUARD, useClass: FakePrincipalGuard }, { provide: AuditSink, useClass: FakeAuditSink }],
})
class TestAppModule {}

describe('AuditInterceptor (test Nest app)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(TestAppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    record.mockClear();
  });

  it('does not audit a GET', async () => {
    await request(app.getHttpServer()).get('/admin/v1/contacts').expect(200);
    expect(record).not.toHaveBeenCalled();
  });

  it('does not audit a 4xx on a GET', async () => {
    await request(app.getHttpServer()).get('/admin/v1/contacts/boom').expect(404);
    expect(record).not.toHaveBeenCalled();
  });

  it('does not audit a 4xx on a write', async () => {
    await request(app.getHttpServer()).post('/admin/v1/contacts/boom').expect(400);
    expect(record).not.toHaveBeenCalled();
  });

  it('audits a successful POST with the request body as diff', async () => {
    await request(app.getHttpServer()).post('/admin/v1/contacts').send({ email: 'a@b.com' }).expect(201);

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      tenant_id: 'tenant-1',
      actor_type: 'user',
      actor_id: 'user-1',
      action: 'contacts.create',
      resource_type: 'contacts',
      resource_id: 'c-1',
      diff: { email: 'a@b.com' },
    });
  });

  it('audits a successful DELETE with a null diff', async () => {
    await request(app.getHttpServer()).delete('/admin/v1/contacts/c-2').expect(200);

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      action: 'contacts.delete',
      resource_type: 'contacts',
      resource_id: 'c-2',
      diff: null,
    });
  });
});
