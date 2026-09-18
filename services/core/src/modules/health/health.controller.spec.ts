import { Test } from '@nestjs/testing';
import { NatsModule } from '@oe/ts-common/nats';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { HealthController } from './health.controller.js';
import { HealthModule } from './health.module.js';

jest.setTimeout(120_000);

describe('health (Postgres + NATS via testcontainers)', () => {
  let pg: StartedPostgreSqlContainer;
  let pgStopped = false;
  let nats: StartedTestContainer;
  let controller: HealthController;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:17-alpine').start();
    nats = await new GenericContainer('nats:2.11-alpine')
      .withCommand(['-js'])
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
      .start();

    process.env.DATABASE_URL = pg.getConnectionUri();

    const moduleRef = await Test.createTestingModule({
      imports: [
        NatsModule.forRoot({
          servers: `${nats.getHost()}:${nats.getMappedPort(4222)}`,
          source: 'core-test',
        }),
        HealthModule,
      ],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  afterAll(async () => {
    if (!pgStopped) await pg.stop();
    await nats.stop();
  });

  it('healthz always reports ok', () => {
    expect(controller.healthz()).toBe('ok');
  });

  it('readyz reports ok when postgres and nats are reachable', async () => {
    await expect(controller.readyz()).resolves.toBe('ok');
  });

  it('readyz fails once postgres is unreachable', async () => {
    await pg.stop();
    pgStopped = true;

    await expect(controller.readyz()).rejects.toThrow(/postgres not ready/);
  });
});
