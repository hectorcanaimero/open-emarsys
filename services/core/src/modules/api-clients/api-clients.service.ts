import { randomBytes } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { buildCursorPage, type CursorPage, parseCursorQuery } from '@oe/ts-common/http';
import { NatsPublisher } from '@oe/ts-common/nats';
import { TenantContext } from '@oe/ts-common/tenant';
import type { ApiClient, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { ARGON2_OPTIONS } from '../auth/auth.module.js';
import { PERMISSION_ACTIONS, PERMISSION_MODULES } from '../identity-shared/permissions.js';

const CATALOG = new Set<string>(PERMISSION_MODULES.flatMap((m) => PERMISSION_ACTIONS.map((a) => `${m}:${a}`)));

export const apiClientInput = z.object({
  name: z.string().min(1).max(100),
  scopes: z
    .array(z.string().refine((s) => CATALOG.has(s), { message: 'unknown permission' }))
    .min(1)
    .refine((s) => new Set(s).size === s.length, { message: 'scopes must be unique' }),
});
export type ApiClientInput = z.infer<typeof apiClientInput>;

/** Published on revocation so verifiers outside core drop the client's tokens (see OAuthService). */
export const API_CLIENT_REVOKED = 'system.api_client.revoked';

export interface ApiClientDto {
  id: string;
  client_id: string;
  name: string;
  scopes: string[];
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

// secretHash is deliberately never mapped.
function toDto(c: ApiClient): ApiClientDto {
  return {
    id: c.id,
    client_id: c.clientId,
    name: c.name,
    scopes: c.scopes,
    status: c.revokedAt ? 'revoked' : 'active',
    created_at: c.createdAt.toISOString(),
    revoked_at: c.revokedAt?.toISOString() ?? null,
    last_used_at: c.lastUsedAt?.toISOString() ?? null,
  };
}

const encodeCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64url');
const decodeCursor = (cursor: string) => Buffer.from(cursor, 'base64url').toString('utf8');

@Injectable()
export class ApiClientsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(NatsPublisher) private readonly publisher: NatsPublisher
  ) {}

  list(tenantId: string, query: Record<string, unknown>): Promise<CursorPage<ApiClientDto>> {
    const { cursor, limit } = parseCursorQuery(query, { defaultLimit: 50, maxLimit: 200 });
    return TenantContext.run(tenantId, async () => {
      const rows = await this.prisma.apiClient.findMany({
        where: cursor ? { id: { gt: decodeCursor(cursor) } } : {},
        orderBy: { id: 'asc' },
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      return buildCursorPage(page.map(toDto), rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null);
    });
  }

  /** The only place `client_secret` (32 random bytes) exists in clear; only its Argon2id hash is stored. */
  create(tenantId: string, input: ApiClientInput): Promise<ApiClientDto & { client_secret: string }> {
    return TenantContext.run(tenantId, async () => {
      const client_secret = randomBytes(32).toString('base64url');
      const row = await this.prisma.apiClient.create({
        data: {
          tenantId,
          clientId: `oec_${randomBytes(16).toString('hex')}`,
          name: input.name,
          scopes: input.scopes,
          secretHash: await hash(client_secret, ARGON2_OPTIONS),
        },
      });
      return { ...toDto(row), client_secret };
    });
  }

  /** Idempotent; republishes the event each time so a failed publish can be retried. */
  revoke(tenantId: string, id: string): Promise<ApiClientDto> {
    return TenantContext.run(tenantId, async () => {
      await this.prisma.apiClient.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
      const row = await this.prisma.apiClient.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('API client not found');
      await this.publisher.publish(API_CLIENT_REVOKED, tenantId, null, {
        client_id: row.clientId,
        revoked_at: row.revokedAt!.toISOString(),
      });
      return toDto(row);
    });
  }
}
