import type { Prisma } from '@prisma/client';
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  type PermissionAction,
  type PermissionModule,
} from '../identity-shared/permissions.js';

/**
 * Business modules a tenant's own roles can be granted (FR-1 default roles): every
 * catalog module except `platform` and `identity`, which are administrative and stay
 * Admin-only.
 */
const MARKETING_MODULES: readonly PermissionModule[] = PERMISSION_MODULES.filter(
  (module) => module !== 'platform' && module !== 'identity'
);

interface RoleGrant {
  module: PermissionModule;
  action: PermissionAction;
}

interface DefaultRoleSpec {
  name: string;
  permissions: RoleGrant[];
}

const ADMIN_PERMISSIONS: RoleGrant[] = PERMISSION_MODULES.flatMap((module) =>
  PERMISSION_ACTIONS.map((action) => ({ module, action }))
);

const MARKETER_PERMISSIONS: RoleGrant[] = MARKETING_MODULES.flatMap((module) =>
  (['view', 'edit', 'launch'] as const).map((action) => ({ module, action }))
);

const VIEWER_PERMISSIONS: RoleGrant[] = MARKETING_MODULES.map((module) => ({
  module,
  action: 'view' as const,
}));

/** Seeded for every new tenant (FR-1): `Admin`, `Marketer` and `Viewer`, all non-deletable. */
export const DEFAULT_TENANT_ROLES: readonly DefaultRoleSpec[] = [
  { name: 'Admin', permissions: ADMIN_PERMISSIONS },
  { name: 'Marketer', permissions: MARKETER_PERMISSIONS },
  { name: 'Viewer', permissions: VIEWER_PERMISSIONS },
];

/** Creates the default roles and their permissions for a freshly created tenant; returns the `Admin` role id. */
export async function createDefaultTenantRoles(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<string> {
  let adminRoleId = '';
  for (const spec of DEFAULT_TENANT_ROLES) {
    const role = await tx.role.create({
      data: { tenantId, name: spec.name, isDefault: true },
    });
    if (spec.name === 'Admin') adminRoleId = role.id;
    await tx.rolePermission.createMany({
      data: spec.permissions.map((grant) => ({
        roleId: role.id,
        tenantId,
        module: grant.module,
        action: grant.action,
      })),
    });
  }
  return adminRoleId;
}
