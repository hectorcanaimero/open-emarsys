import { hash } from '@node-rs/argon2';
import { withSystemScope } from '@oe/ts-common/prisma-tenant';
import type { Prisma, PrismaClient } from '@prisma/client';

const OPERATOR_ROLE_NAME = 'Operator';

/** Bootstrap operator permissions (`tenants` tag, `contracts/openapi/admin-v1/identity.yaml`). */
const OPERATOR_PERMISSIONS = [
  { module: 'tenants', action: 'view' },
  { module: 'tenants', action: 'admin' },
] as const;

export interface CreateOperatorInput {
  email: string;
  password: string;
}

export interface CreateOperatorResult {
  created: boolean;
  userId: string;
}

/**
 * Bootstraps the first platform operator (FR-1), without going through HTTP: no login flow
 * exists yet to accept an invitation, so the very first account has to be seeded directly.
 * Idempotent — re-running with an email that already has an operator account is a no-op.
 */
export async function createOperator(
  prisma: PrismaClient,
  input: CreateOperatorInput
): Promise<CreateOperatorResult> {
  return withSystemScope(() =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.user.findFirst({
        where: { tenantId: null, email: { equals: input.email, mode: 'insensitive' } },
      });
      if (existing) return { created: false, userId: existing.id };

      const passwordHash = await hash(input.password);
      const user = await tx.user.create({
        data: { tenantId: null, email: input.email, passwordHash, status: 'active' },
      });

      let role = await tx.role.findFirst({ where: { tenantId: null, name: OPERATOR_ROLE_NAME } });
      if (!role) {
        role = await tx.role.create({ data: { tenantId: null, name: OPERATOR_ROLE_NAME, isDefault: true } });
        await tx.rolePermission.createMany({
          data: OPERATOR_PERMISSIONS.map((grant) => ({
            roleId: role!.id,
            tenantId: null,
            module: grant.module,
            action: grant.action,
          })),
        });
      }
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id, tenantId: null } });

      return { created: true, userId: user.id };
    })
  );
}
