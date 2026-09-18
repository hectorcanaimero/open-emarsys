import { randomUUID } from 'node:crypto';
import { verify as verifyPassword } from '@node-rs/argon2';
import type { INestApplication } from '@nestjs/common';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { TenantContext } from '@oe/ts-common/tenant';
import type { PrismaClient, UserStatus } from '@prisma/client';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MAIL_TRANSPORT } from './mailer.js';
import { generateTestKeys, signPrincipal, startTestApp, startTestDatabase, type TestKeys } from './testing/harness.js';
import { UsersModule } from './users.module.js';

jest.setTimeout(180_000);

const PERMS_VIEW = ['identity:view'];
const PERMS_ADMIN = ['identity:admin', 'identity:view'];

describe('users + invitations (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let rawPrisma: PrismaClient;
  let scoped: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  let keys: TestKeys;
  let sentMails: { to: string; html: string }[];

  const as = <T>(tenantId: string, fn: () => Promise<T>) => TenantContext.run(tenantId, async () => await fn());

  beforeAll(async () => {
    const db = await startTestDatabase();
    container = db.container;
    rawPrisma = db.prisma;
    scoped = withTenantScope(rawPrisma);
    keys = await generateTestKeys();
    sentMails = [];
    const fakeTransport = {
      sendMail: async (msg: { to: string; html: string }) => {
        sentMails.push({ to: msg.to, html: msg.html });
      },
    };

    ({ app, baseUrl } = await startTestApp({
      imports: [UsersModule],
      prisma: rawPrisma,
      keys,
      overrides: [[MAIL_TRANSPORT, fakeTransport]],
    }));
  });

  afterAll(async () => {
    await app.close();
    await rawPrisma.$disconnect();
    await container.stop();
  });

  async function seedTenant(): Promise<{ tenantId: string; adminRoleId: string; viewerRoleId: string }> {
    const tenantId = randomUUID();
    return as(tenantId, async () => {
      await scoped.tenant.create({ data: { id: tenantId, name: tenantId, timezone: 'UTC' } });
      const admin = await scoped.role.create({ data: { tenantId, name: 'Admin', isDefault: true } });
      const viewer = await scoped.role.create({ data: { tenantId, name: 'Viewer', isDefault: true } });
      return { tenantId, adminRoleId: admin.id, viewerRoleId: viewer.id };
    });
  }

  async function seedUser(tenantId: string, roleId: string, email: string, status: UserStatus = 'active') {
    // Two flat creates, not a nested relational write: `withTenantScope`'s per-operation
    // tenant-scoping only wraps each top-level Prisma Client call, and a nested write bypasses
    // that wrapping for the child operation (it does not run under `TenantContext.run`).
    return as(tenantId, async () => {
      const user = await scoped.user.create({ data: { tenantId, email, status } });
      await scoped.userRole.create({ data: { userId: user.id, roleId, tenantId } });
      return user;
    });
  }

  it('lists users of the tenant with cursor pagination and email search', async () => {
    const { tenantId, adminRoleId } = await seedTenant();
    const admin = await seedUser(tenantId, adminRoleId, 'admin@list.test');
    await seedUser(tenantId, adminRoleId, 'bob@list.test');
    await seedUser(tenantId, adminRoleId, 'carol@list.test');
    const token = await signPrincipal(keys, { sub: admin.id, tenant_id: tenantId, perms: PERMS_VIEW });

    const first = await fetch(`${baseUrl}/admin/v1/users?limit=2`, { headers: { authorization: `Bearer ${token}` } });
    expect(first.status).toBe(200);
    const firstPage = await first.json();
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.next_cursor).not.toBeNull();

    const second = await fetch(`${baseUrl}/admin/v1/users?cursor=${firstPage.next_cursor}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const secondPage = await second.json();
    expect(secondPage.next_cursor).toBeNull();
    expect(secondPage.items).toHaveLength(1);

    const search = await fetch(`${baseUrl}/admin/v1/users?email=bob`, { headers: { authorization: `Bearer ${token}` } });
    const searchPage = await search.json();
    expect(searchPage.items.map((u: { email: string }) => u.email)).toEqual(['bob@list.test']);
  });

  it('401s without a token and 403s a Viewer trying to update a user', async () => {
    const { tenantId, adminRoleId, viewerRoleId } = await seedTenant();
    const admin = await seedUser(tenantId, adminRoleId, 'admin@perm.test');
    const viewerUser = await seedUser(tenantId, viewerRoleId, 'viewer@perm.test');
    const viewerToken = await signPrincipal(keys, { sub: viewerUser.id, tenant_id: tenantId, perms: PERMS_VIEW });

    const anon = await fetch(`${baseUrl}/admin/v1/users?limit=1`);
    expect(anon.status).toBe(401);

    const res = await fetch(`${baseUrl}/admin/v1/users/${admin.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses to delete the last active Admin of a tenant, but allows it once another remains', async () => {
    const { tenantId, adminRoleId } = await seedTenant();
    const onlyAdmin = await seedUser(tenantId, adminRoleId, 'only-admin@last.test');
    const token = await signPrincipal(keys, { sub: onlyAdmin.id, tenant_id: tenantId, perms: PERMS_ADMIN });

    const blocked = await fetch(`${baseUrl}/admin/v1/users/${onlyAdmin.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blocked.status).toBe(409);

    const secondAdmin = await seedUser(tenantId, adminRoleId, 'second-admin@last.test');
    const allowed = await fetch(`${baseUrl}/admin/v1/users/${secondAdmin.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowed.status).toBe(204);
  });

  it('refuses to disable or un-admin the last Admin via PATCH', async () => {
    const { tenantId, adminRoleId, viewerRoleId } = await seedTenant();
    const onlyAdmin = await seedUser(tenantId, adminRoleId, 'only-admin@patch.test');
    const token = await signPrincipal(keys, { sub: onlyAdmin.id, tenant_id: tenantId, perms: PERMS_ADMIN });

    const disable = await fetch(`${baseUrl}/admin/v1/users/${onlyAdmin.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(disable.status).toBe(409);

    const demote = await fetch(`${baseUrl}/admin/v1/users/${onlyAdmin.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role_ids: [viewerRoleId] }),
    });
    expect(demote.status).toBe(409);
  });

  it('invites a user, emails the acceptance link, and accepting it creates working credentials', async () => {
    const { tenantId, adminRoleId, viewerRoleId } = await seedTenant();
    const admin = await seedUser(tenantId, adminRoleId, 'inviter@accept.test');
    const token = await signPrincipal(keys, { sub: admin.id, tenant_id: tenantId, perms: PERMS_ADMIN });

    const inviteRes = await fetch(`${baseUrl}/admin/v1/users/invitations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'newbie@accept.test', role_ids: [viewerRoleId] }),
    });
    expect(inviteRes.status).toBe(201);
    const invitation = await inviteRes.json();
    expect(invitation.email).toBe('newbie@accept.test');

    const mail = sentMails.find((m) => m.to === 'newbie@accept.test');
    expect(mail).toBeDefined();
    const match = mail!.html.match(/invite\/([^"]+)/);
    expect(match).not.toBeNull();
    const inviteToken = match![1];

    const acceptRes = await fetch(`${baseUrl}/admin/v1/invitations/${inviteToken}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Newbie', password: 'a-very-long-unique-passphrase-99' }),
    });
    expect(acceptRes.status).toBe(200);
    const user = await acceptRes.json();
    expect(user.status).toBe('active');
    expect(user.role_ids).toContain(viewerRoleId);

    // Real login is exercised end-to-end by F0.8.T4; here we confirm the stored credential
    // is exactly what a login attempt would verify against.
    const stored = await as(tenantId, () => scoped.user.findUniqueOrThrow({ where: { id: user.id } }));
    expect(stored.passwordHash).not.toBeNull();
    await expect(verifyPassword(stored.passwordHash!, 'a-very-long-unique-passphrase-99')).resolves.toBe(true);
  });

  it('rejects a common password on accept', async () => {
    const { tenantId, adminRoleId, viewerRoleId } = await seedTenant();
    const admin = await seedUser(tenantId, adminRoleId, 'inviter@common.test');
    const token = await signPrincipal(keys, { sub: admin.id, tenant_id: tenantId, perms: PERMS_ADMIN });

    await fetch(`${baseUrl}/admin/v1/users/invitations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'weak@common.test', role_ids: [viewerRoleId] }),
    });
    const mail = sentMails.find((m) => m.to === 'weak@common.test')!;
    const inviteToken = mail.html.match(/invite\/([^"]+)/)![1];

    const res = await fetch(`${baseUrl}/admin/v1/invitations/${inviteToken}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Weak', password: 'password1234' }),
    });
    expect(res.status).toBe(400);
  });
});
