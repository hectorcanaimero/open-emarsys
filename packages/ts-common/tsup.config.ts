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
  // Entries share classes that are DI tokens (NatsPublisher) and one AsyncLocalStorage
  // (TenantContext). Without splitting each entry inlines its own copy: Nest cannot match
  // audit's NatsPublisher to the one NatsModule provides, and prisma-tenant never sees the
  // tenant that tenant/auth set. Shared code goes to chunks every entry requires.
  splitting: true,
  sourcemap: false,
  clean: true,
  outDir: 'dist',
});
