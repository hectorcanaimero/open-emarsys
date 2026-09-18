import type { Config } from 'jest';

const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  // Most specs start their own Postgres container. Jest's default (cores - 1 = 15 here)
  // ran that many at once and OOM-killed the CI runner on this 14 GB machine.
  maxWorkers: 2,
  transform: { '^.+\\.tsx?$': ['ts-jest', {}] },
  testRegex: '.*\\.(spec|test)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Sources import `./x.js` (NodeNext); map those back to the .ts files.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testTimeout: 30_000,
};

export default config;
