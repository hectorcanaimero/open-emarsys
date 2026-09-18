import { setupServer } from 'msw/node';

/** Shared MSW node server for settings screen tests; each spec registers its own handlers. */
export const server = setupServer();
