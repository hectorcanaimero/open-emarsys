import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, GoneException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { hash as hashPassword } from '@node-rs/argon2';
import { TenantContext } from '@oe/ts-common/tenant';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../prisma/prisma.module.js';
import { isCommonPassword } from './common-passwords.js';
import type { AcceptInvitationInput, InviteUserInput } from './dto.js';
import { InviteMailer } from './mailer.js';
import { toUserDto, type UserDto } from './user.mapper.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InvitationDto {
  id: string;
  user_id: string;
  email: string;
  expires_at: string;
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * The public `/invitations/{token}/accept` route has no tenant yet (no JWT). Rather than
 * bypass RLS, the opaque token embeds the tenant id (`<tenant-id>.<random>`): the random part
 * is still 32 bytes of entropy and only its hash is ever stored, so this leaks nothing beyond
 * which tenant the invitation belongs to — the same tenant the link's `[locale]` prefix reveals.
 */
function splitToken(token: string): { tenantId: string; rawToken: string } {
  const idx = token.indexOf('.');
  const tenantId = idx > 0 ? token.slice(0, idx) : '';
  const rawToken = idx > 0 ? token.slice(idx + 1) : '';
  if (!UUID_RE.test(tenantId) || rawToken.length === 0) throw new NotFoundException('invitation not found');
  return { tenantId, rawToken };
}

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly mailer: InviteMailer
  ) {}

  async invite(tenantId: string, invitedBy: string, input: InviteUserInput): Promise<InvitationDto> {
    return TenantContext.run(tenantId, async () => {
      const roleCount = await this.prisma.role.count({ where: { tenantId, id: { in: input.role_ids } } });
      if (roleCount !== input.role_ids.length) throw new NotFoundException('one or more roles not found');

      const existing = await this.prisma.user.findFirst({
        where: { tenantId, email: { equals: input.email, mode: 'insensitive' } },
      });
      if (existing) throw new ConflictException('a user with this email already exists in this tenant');

      const rawToken = randomBytes(32).toString('base64url');
      const locale = input.locale ?? 'es';

      const invitation = await this.prisma
        .$transaction(async (tx) => {
          const user = await tx.user.create({ data: { tenantId, email: input.email, locale, status: 'invited' } });
          await tx.userRole.createMany({
            data: input.role_ids.map((roleId) => ({ userId: user.id, roleId, tenantId })),
          });
          return tx.invitation.create({
            data: {
              tenantId,
              userId: user.id,
              email: input.email,
              tokenHash: hashToken(rawToken),
              roleIds: input.role_ids,
              invitedBy,
              expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
            },
          });
        })
        .catch((err) => {
          throw isUniqueViolation(err) ? new ConflictException('a user with this email already exists in this tenant') : err;
        });

      await this.mailer.sendInvite({ to: input.email, token: `${tenantId}.${rawToken}`, locale });

      return {
        id: invitation.id,
        user_id: invitation.userId!,
        email: invitation.email,
        expires_at: invitation.expiresAt.toISOString(),
      };
    });
  }

  async accept(compositeToken: string, input: AcceptInvitationInput): Promise<UserDto> {
    const { tenantId, rawToken } = splitToken(compositeToken);

    return TenantContext.run(tenantId, async () => {
      const invitation = await this.prisma.invitation.findFirst({
        where: { tenantId, tokenHash: hashToken(rawToken) },
      });
      if (!invitation) throw new NotFoundException('invitation not found');
      if (invitation.acceptedAt) throw new GoneException('invitation already used');
      if (invitation.expiresAt.getTime() < Date.now()) throw new GoneException('invitation expired');

      if (isCommonPassword(input.password)) {
        throw new BadRequestException({ errors: [{ pointer: '/password', detail: 'this password is too common' }] });
      }
      const passwordHash = await hashPassword(input.password);

      const user = await this.prisma.$transaction(async (tx) => {
        await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
        return tx.user.update({
          where: { id: invitation.userId! },
          data: { name: input.name, passwordHash, status: 'active' },
          include: { roles: true },
        });
      });
      return toUserDto(user);
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
