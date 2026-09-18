import type { Prisma } from '@prisma/client';

export type UserWithRoles = Prisma.UserGetPayload<{ include: { roles: true } }>;

export interface UserDto {
  id: string;
  tenant_id: string | null;
  email: string;
  name: string | null;
  locale: string;
  status: 'invited' | 'active' | 'locked' | 'disabled';
  mfa_enabled: boolean;
  role_ids: string[];
  created_at: string;
  last_login_at: string | null;
}

/** `locked` is derived from `lockedUntil`, never stored (identity.prisma). */
export function toUserDto(user: UserWithRoles): UserDto {
  const locked = user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
  return {
    id: user.id,
    tenant_id: user.tenantId,
    email: user.email,
    name: user.name,
    locale: user.locale,
    status: locked ? 'locked' : user.status,
    mfa_enabled: user.mfaEnabled,
    role_ids: user.roles.map((r) => r.roleId),
    created_at: user.createdAt.toISOString(),
    last_login_at: user.lastLoginAt?.toISOString() ?? null,
  };
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}
