import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest defaults to one worker per core (16 here); bounded so CI and parallel agents fit in RAM.
    minWorkers: 1,
    maxWorkers: 4,
    include: ['src/**/*.spec.ts'],
  },
});
