# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
# Prisma's query engine needs OpenSSL on musl (alpine).
RUN apk add --no-cache openssl
RUN corepack enable

FROM base AS builder
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @oe/core... build

FROM base AS runner
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=builder /repo /repo
RUN addgroup --system --gid 1001 core \
  && adduser --system --uid 1001 core \
  && chown -R core:core /repo
USER core
WORKDIR /repo/services/core
EXPOSE 3000
CMD ["node", "dist/main.js"]
