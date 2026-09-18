import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { withSystemScope } from '@oe/ts-common/prisma-tenant';
import type { Locale, PrismaClient, Tenant, User } from '@prisma/client';
import { authenticator } from 'otplib';
import { JwtSigner } from './jwt-signer.js';

export const AUTH_OPTIONS = Symbol('oe:core:auth-options');
export const AUTH_PRISMA = Symbol('oe:core:auth-prisma');

export interface AuthOptions {
  signer: JwtSigner;
  /** `CORE_ENCRYPTION_KEY`: 32 bytes, base64. Seals TOTP secrets with AES-256-GCM (NFR-9). */
  encryptionKey: string;
  /**
   * Role with BYPASSRLS used through `withSystemScope`: login, MFA and refresh look users up
   * before the tenant is known, and operators have no tenant. The `core` role must be a member.
   */
  systemRole: string;
  /** Overrides `DATABASE_URL`. */
  databaseUrl?: string;
  /** Clock for lockout and refresh expiry; tests move it. */
  now?: () => Date;
}

// OWASP Password Storage Cheat Sheet: Argon2id, m=19 MiB, t=2, p=1 (argon2id is the default).
export const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const ACCESS_TTL = 15 * 60;
const MFA_TTL = 5 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const RECOVERY_CODES = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const totp = authenticator.clone({ window: 1 });

export interface TokenPair {
  mfa_required: false;
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}
export type LoginResult = TokenPair | { mfa_required: true; mfa_token: string };

export class AccountLockedException extends HttpException {
  constructor(readonly retryAfter: number) {
    super('Account locked after too many failed attempts', HttpStatus.LOCKED);
  }
}

const invalidCredentials = () => new UnauthorizedException('Invalid email or password');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

@Injectable()
export class AuthService {
  private readonly key: Buffer;
  private readonly now: () => Date;
  // Verified against when no account matches, so unknown emails take as long as wrong passwords.
  private readonly dummyHash = hash(randomUUID(), ARGON2_OPTIONS);

  constructor(
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
    @Inject(AUTH_PRISMA) private readonly prisma: PrismaClient
  ) {
    this.key = Buffer.from(options.encryptionKey, 'base64');
    if (this.key.length !== 32) throw new Error('CORE_ENCRYPTION_KEY must be 32 bytes, base64');
    this.now = options.now ?? (() => new Date());
  }

  login(email: string, password: string): Promise<LoginResult> {
    return withSystemScope(async () => {
      const now = this.now();
      // Emails are unique per tenant only, so the same address may exist in several tenants.
      const ids = await this.prisma.$transaction(
        (tx) => tx.$queryRaw<Array<{ id: string }>>`select id from identity.users where lower(email) = lower(${email})`
      );
      const users = await this.prisma.user.findMany({
        where: { id: { in: ids.map((r) => r.id) }, passwordHash: { not: null } },
        include: { tenant: true },
      });
      const open = users.filter((u) => !this.lockedFor(u, now));

      let user: (typeof users)[number] | undefined;
      for (const u of open) {
        if (await verify(u.passwordHash!, password)) {
          user = u;
          break;
        }
      }
      if (!open.length) await verify(await this.dummyHash, password);

      if (!user) {
        const locked = users.find((u) => this.lockedFor(u, now));
        if (locked) throw new AccountLockedException(this.lockedFor(locked, now));
        for (const u of open) await this.recordFailure(u.id, now);
        throw invalidCredentials();
      }
      this.checkActive(user, user.tenant);
      if (user.mfaEnabled) {
        const mfa_token = await this.options.signer.sign(
          { sub: user.id, typ: 'mfa', tenant_id: user.tenantId },
          MFA_TTL
        );
        return { mfa_required: true, mfa_token };
      }
      return this.issue(user, randomUUID(), now);
    });
  }

  /** Completes an MFA login with a TOTP code or a single-use recovery code. */
  verifyMfa(mfaToken: string, code: string): Promise<TokenPair> {
    return withSystemScope(async () => {
      const now = this.now();
      let sub: string;
      try {
        sub = (await this.options.signer.verify(mfaToken, 'mfa')).sub!;
      } catch {
        throw new UnauthorizedException('Invalid or expired MFA token');
      }
      const user = await this.prisma.user.findUnique({ where: { id: sub }, include: { tenant: true } });
      if (!user?.mfaEnabled || !user.mfaSecret) throw new UnauthorizedException('Invalid or expired MFA token');
      const lockedFor = this.lockedFor(user, now);
      if (lockedFor) throw new AccountLockedException(lockedFor);
      this.checkActive(user, user.tenant);

      const ok = /^\d{6}$/.test(code)
        ? this.checkTotp(user.mfaSecret, code)
        : (
            await this.prisma.mfaRecoveryCode.updateMany({
              where: { userId: user.id, codeHash: sha256(normalizeRecovery(code)), usedAt: null },
              data: { usedAt: now },
            })
          ).count === 1;
      if (!ok) {
        await this.recordFailure(user.id, now);
        throw new UnauthorizedException('Invalid code');
      }
      return this.issue(user, randomUUID(), now);
    });
  }

  /** Rotates a refresh token. Presenting one already rotated or revoked revokes its family. */
  refresh(token: string): Promise<TokenPair> {
    return withSystemScope(async () => {
      const now = this.now();
      const invalid = () => new UnauthorizedException('Invalid refresh token');
      const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
      if (!row || row.expiresAt <= now) throw invalid();
      const { count } = await this.prisma.refreshToken.updateMany({
        where: { id: row.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now },
      });
      if (!count) {
        await this.revokeFamily(row.familyId, now);
        throw invalid();
      }
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: row.userId }, include: { tenant: true } });
      this.checkActive(user, user.tenant);
      return this.issue(user, row.familyId, now);
    });
  }

  /** Ends the session the refresh token belongs to, if it is the caller's. */
  logout(userId: string, token: string): Promise<void> {
    return withSystemScope(async () => {
      const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
      if (row?.userId === userId) await this.revokeFamily(row.familyId, this.now());
    });
  }

  enrollMfa(userId: string): Promise<{ secret: string; otpauth_uri: string }> {
    return withSystemScope(async () => {
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.mfaEnabled) throw new ConflictException('MFA is already enabled');
      const secret = totp.generateSecret();
      await this.prisma.user.update({ where: { id: userId }, data: { mfaSecret: this.seal(secret) } });
      return { secret, otpauth_uri: totp.keyuri(user.email, 'open-emarsys', secret) };
    });
  }

  /** Activates the pending secret and returns 10 single-use recovery codes (shown once). */
  confirmMfa(userId: string, code: string): Promise<{ recovery_codes: string[] }> {
    return withSystemScope(async () => {
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.mfaEnabled || !user.mfaSecret) throw new ConflictException('No pending MFA enrollment');
      if (!this.checkTotp(user.mfaSecret, code)) throw new BadRequestException('Invalid code');
      const codes = Array.from({ length: RECOVERY_CODES }, () => {
        const c = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
        return `${c.slice(0, 5)}-${c.slice(5)}`;
      });
      await this.prisma.$transaction([
        this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
        this.prisma.mfaRecoveryCode.createMany({
          data: codes.map((c) => ({ userId, tenantId: user.tenantId, codeHash: sha256(normalizeRecovery(c)) })),
        }),
        this.prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } }),
      ]);
      return { recovery_codes: codes };
    });
  }

  disableMfa(userId: string, code: string): Promise<void> {
    return withSystemScope(async () => {
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      if (!user.mfaEnabled || !user.mfaSecret) throw new NotFoundException('MFA is not enabled');
      if (!this.checkTotp(user.mfaSecret, code)) throw new BadRequestException('Invalid code');
      await this.prisma.$transaction([
        this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
        this.prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecret: null } }),
      ]);
    });
  }

  updateMe(userId: string, patch: { locale: Locale }) {
    return withSystemScope(async () => {
      const u = await this.prisma.user.update({
        where: { id: userId },
        data: patch,
        include: { roles: { select: { roleId: true } } },
      });
      return {
        id: u.id,
        tenant_id: u.tenantId,
        email: u.email,
        name: u.name,
        locale: u.locale,
        status: this.lockedFor(u, this.now()) ? 'locked' : u.status,
        mfa_enabled: u.mfaEnabled,
        role_ids: u.roles.map((r) => r.roleId),
        created_at: u.createdAt.toISOString(),
        last_login_at: u.lastLoginAt?.toISOString() ?? null,
      };
    });
  }

  private async issue(user: User, familyId: string, now: Date): Promise<TokenPair> {
    const grants = await this.prisma.rolePermission.findMany({
      where: { role: { users: { some: { userId: user.id } } } },
      select: { module: true, action: true },
    });
    const perms = [...new Set(grants.map((g) => `${g.module}:${g.action}`))].sort();
    const access_token = await this.options.signer.sign(
      { sub: user.id, typ: 'user', tenant_id: user.tenantId, perms },
      ACCESS_TTL
    );
    const refresh_token = randomBytes(32).toString('base64url');
    await this.prisma.$transaction([
      this.prisma.refreshToken.create({
        data: {
          userId: user.id,
          tenantId: user.tenantId,
          familyId,
          tokenHash: sha256(refresh_token),
          expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
        },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now },
      }),
    ]);
    return { mfa_required: false, access_token, refresh_token, token_type: 'Bearer', expires_in: ACCESS_TTL };
  }

  /** Counts a failure; the fifth in a row locks the account for 15 minutes (423). */
  private async recordFailure(userId: string, now: Date): Promise<void> {
    const u = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLogins: { increment: 1 } },
    });
    if (u.failedLogins < MAX_FAILURES) return;
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) },
    });
    throw new AccountLockedException(LOCK_MS / 1000);
  }

  /** Seconds the account stays locked, 0 if it is not. */
  private lockedFor(u: Pick<User, 'lockedUntil'>, now: Date): number {
    const ms = (u.lockedUntil?.getTime() ?? 0) - now.getTime();
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  private checkActive(user: User, tenant: Tenant | null): void {
    if (user.status !== 'active') throw invalidCredentials();
    if (tenant?.status === 'suspended') throw new ForbiddenException('Tenant is suspended');
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
  }

  // ponytail: a valid TOTP code can be replayed within its ±1 step window; track the last
  // used step per user if that matters.
  private checkTotp(sealedSecret: string, code: string): boolean {
    return totp.check(code, this.open(sealedSecret));
  }

  /** AES-256-GCM: `base64url(iv).base64url(ciphertext).base64url(tag)`. */
  private seal(plaintext: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return [iv, ct, c.getAuthTag()].map((b) => b.toString('base64url')).join('.');
  }

  private open(sealed: string): string {
    const [iv, ct, tag] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
}
