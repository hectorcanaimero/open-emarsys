import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    // next-intl's ESM build imports `next/navigation` without an extension, which Node's
    // resolver rejects when the package is externalized; let vite transform it instead.
    server: { deps: { inline: ['next-intl'] } },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
