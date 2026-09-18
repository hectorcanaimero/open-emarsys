import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    config: 'src/config/index.ts',
    otel: 'src/otel/index.ts',
    http: 'src/http/index.ts',
    auth: 'src/auth/index.ts',
    tenant: 'src/tenant/index.ts',
    'prisma-tenant': 'src/prisma-tenant/index.ts',
    nats: 'src/nats/index.ts',
    audit: 'src/audit/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  outDir: 'dist',
});
