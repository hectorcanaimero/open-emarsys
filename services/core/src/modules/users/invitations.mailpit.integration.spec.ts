import { randomUUID } from 'node:crypto';
import { verify as verifyPassword } from '@node-rs/argon2';
import type { INestApplication } from '@nestjs/common';
import { withTenantScope } from '@oe/ts-common/prisma-tenant';
import { TenantContext } from '@oe/ts-common/tenant';
import type { PrismaClient } from '@prisma/client';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { generateTestKeys, signPrincipal, startTestApp, startTestDatabase, type TestKeys } from './testing/harness.js';
import { UsersModule } from './users.module.js';

jest.setTimeout(180_000);

const PERMS_ADMIN = ['identity:admin', 'identity:view'];

/**
 * Exercises the real SMTP path (nodemailer -> Mailpit) end to end, since `users.integration
 * .spec.ts` fakes the transport to stay fast. Covers the task's own "invite -> email in
 * Mailpit (Mailpit API) -> accept -> credentials usable for login" and the expired/reused
 * token requirements. Login itself is F0.6.T4/F0.8.T4's job; here we verify the credential
 * accept() produces is exactly what a login attempt would check.
 */
describe('invitations via real SMTP + Mailpit (integration)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let mailpit: StartedTestContainer;
  let rawPrisma: PrismaClient;
  let scoped: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  let mailpitApi: string;
  let keys: TestKeys;

  const as = <T>(tenantId: string, fn: () => Promise<T>) => TenantContext.run(tenantId, async () => await fn());

  beforeAll(async () => {
    const db = await startTestDatabase();
    pgContainer = db.container;
    rawPrisma = db.prisma;
    scoped = withTenantScope(rawPrisma);
    keys = await generateTestKeys();

    mailpit = await new GenericContainer('axllent/mailpit:latest').withExposedPorts(1025, 8025).start();
    const host = mailpit.getHost();
    process.env.SMTP_URL = `smtp://${host}:${mailpit.getMappedPort(1025)}`;
    mailpitApi = `http://${host}:${mailpit.getMappedPort(8025)}`;

    ({ app, baseUrl } = await startTestApp({ imports: [UsersModule], prisma: rawPrisma, keys }));
  });

  afterAll(async () => {
    await app.close();
    await rawPrisma.$disconnect();
    await pgContainer.stop();
    await mailpit.stop();
    delete process.env.SMTP_URL;
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

  async function seedUser(tenantId: string, roleId: string, email: string) {
    // Two flat creates, not a nested relational write: `withTenantScope`'s per-operation
    // tenant-scoping only wraps each top-level Prisma Client call, and a nested write bypasses
    // that wrapping for the child operation (it does not run under `TenantContext.run`).
    return as(tenantId, async () => {
      const user = await scoped.user.create({ data: { tenantId, email, status: 'active' } });
      await scoped.userRole.create({ data: { userId: user.id, roleId, tenantId } });
      return user;
    });
  }

  /** Polls the Mailpit HTTP API for the invite email and pulls the acceptance token out of it. */
  async function fetchInviteToken(email: string): Promise<string> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const search = await fetch(`${mailpitApi}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
      const results = (await search.json()) as { messages?: { ID: string }[] };
      if (results.messages && results.messages.length > 0) {
        const full = await fetch(`${mailpitApi}/api/v1/message/${results.messages[0]!.ID}`);
        const message = (await full.json()) as { HTML: string };
        const match = message.HTML.match(/invite\/([^"]+)/);
        if (match) return match[1]!;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`no invite email arrived in Mailpit for ${email}`);
  }

  it('delivers the invite through Mailpit; accepting it yields credentials that verify like a login would', async () => {
    const { tenantId, adminRoleId, viewerRoleId } = await seedTenant();
    const admin = await seedUser(tenantId, adminRoleId, 'inviter@mailpit.test');
    const token = await signPrincipal(keys, { sub: admin.id, tenant_id: tenantId, perms: PERMS_ADMIN });

    const inviteRes = await fetch(`${baseUrl}/admin/v1/users/invitations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'newbie@mailpit.test', role_ids: [viewerRoleId] }),
    });
    expect(inviteRes.status).toBe(201);

    const inviteToken = await fetchInviteToken('newbie@mailpit.test');

    const acceptRes = await fetch(`${baseUrl}/admin/v1/invitations/${inviteToken}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Newbie', password: 'another-long-passphrase-42' }),
    });
    expect(acceptRes.status).toBe(200);
    const user = (await acceptRes.json()) as { id: string; status: string };
    expect(user.status).toBe('active');

    const stored = await as(tenantId, () => scoped.user.findUniqueOrThrow({ where: { id: user.id } }));
    await expect(verifyPassword(stored.passwordHash!, 'another-long-passphrase-42')).resolves.toBe(true);

    const reuse = await fetch(`${baseUrl}/admin/v1/invitations/${inviteToken}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Newbie', password: 'another-long-passphrase-42' }),
    });
    expect(reuse.status).toBe(410);
  });

  it('an expired invitation token fails with 410', async () => {
    const { tenantId, adminRoleId, viewerRoleId } = await seedTenant();
    const admin = await seedUser(tenantId, adminRoleId, 'inviter@expired.test');
    const token = await signPrincipal(keys, { sub: admin.id, tenant_id: tenantId, perms: PERMS_ADMIN });

    await fetch(`${baseUrl}/admin/v1/users/invitations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'expired@expired.test', role_ids: [viewerRoleId] }),
    });
    const inviteToken = await fetchInviteToken('expired@expired.test');

    await as(tenantId, () =>
      scoped.invitation.updateMany({
        where: { email: 'expired@expired.test' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
    );

    const res = await fetch(`${baseUrl}/admin/v1/invitations/${inviteToken}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Late', password: 'another-long-passphrase-77' }),
    });
    expect(res.status).toBe(410);
  });
});
