// Spins up a disposable `nats-server -js` in Docker for integration tests, so
// this package needs no new test dependency (no testcontainers).
import { execFileSync, spawnSync } from 'node:child_process';
import { connect } from 'nats';

export interface TestNatsServer {
  servers: string;
  stop(): void;
}

export function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

export async function startNatsServer(): Promise<TestNatsServer> {
  const name = `oe-test-nats-${process.pid}-${Date.now()}`;
  const port = 14222 + Math.floor(Math.random() * 4000);
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', `${port}:4222`, 'nats:2.11-alpine', '-js'], {
    stdio: 'ignore',
  });
  const servers = `127.0.0.1:${port}`;
  try {
    await waitForReady(servers);
  } catch (err) {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    throw err;
  }
  return {
    servers,
    stop: () => execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }),
  };
}

async function waitForReady(servers: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const nc = await connect({ servers, timeout: 1_000 });
      await nc.close();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`nats-server did not become ready in time: ${String(lastErr)}`);
}
