# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable

FROM base AS builder
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @oe/admin-web... build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin-web/.next/static ./apps/admin-web/.next/static
# Standalone output only carries files Next's tracer sees; src/i18n/request.ts reads
# messages/<locale>/ with readdirSync at runtime, so the tracer misses it.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin-web/messages ./apps/admin-web/messages
USER nextjs
EXPOSE 3000
ENV PORT=3000
# Next's standalone server binds to $HOSTNAME, which Docker sets to the container id;
# listen on every interface so the healthcheck (and anything on localhost) can reach it.
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/admin-web/server.js"]
