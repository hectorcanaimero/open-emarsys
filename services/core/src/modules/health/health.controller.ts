import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '@oe/ts-common/auth';
import { NATS_CONNECTION } from '@oe/ts-common/nats';
import type { PrismaClient } from '@prisma/client';
import type { NatsConnection } from 'nats';
import { PRISMA_CLIENT } from './tokens.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(NATS_CONNECTION) private readonly nc: NatsConnection
  ) {}

  /** The process is up and can serve requests. */
  @Get('healthz')
  @Public()
  healthz(): string {
    return 'ok';
  }

  /** 200 only if Postgres and NATS both answer, otherwise 503 naming the failure. */
  @Get('readyz')
  @Public()
  async readyz(): Promise<string> {
    await this.checkPostgres();
    await this.checkNats();
    return 'ok';
  }

  private async checkPostgres(): Promise<void> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new ServiceUnavailableException(`postgres not ready: ${(err as Error).message}`);
    }
  }

  private async checkNats(): Promise<void> {
    try {
      await this.nc.rtt();
    } catch (err) {
      throw new ServiceUnavailableException(`nats not ready: ${(err as Error).message}`);
    }
  }
}
