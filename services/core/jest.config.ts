import type { Config } from 'jest';

const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': ['ts-jest', {}] },
  testRegex: '.*\\.(spec|test)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 30_000,
};

export default config;
