import { defineConfig } from '@playwright/test';

// Everything goes through the gateway (Traefik), like a real browser would.
export default defineConfig({
  testDir: '.',
  testMatch: '*/**/*.spec.ts',
  // One worker: the gateway rate-limits login per IP (10/min) and scenarios share the seed tenant.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
});
