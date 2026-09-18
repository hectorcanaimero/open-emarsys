/**
 * Mirrors the module catalog seeded by `services/core` (F0.6.T2,
 * `identity-shared/permissions.ts`) — kept here too since admin-web can't
 * import a backend module across the network boundary.
 */
export const PERMISSION_MODULES = [
  'platform',
  'identity',
  'contacts',
  'events',
  'segments',
  'email',
  'campaigns',
  'automation',
  'predict',
  'channels',
  'analytics',
  'loyalty',
  'integrations',
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const PERMISSION_ACTIONS = ['view', 'edit', 'launch', 'admin'] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** Every tenant is seeded with these roles (F0.6.T3); they can't be deleted. */
export const DEFAULT_ROLE_NAMES = ['Admin', 'Marketer', 'Viewer'];

export function isDefaultRole(name: string): boolean {
  return DEFAULT_ROLE_NAMES.includes(name);
}

export function permissionKey(module: string, action: string): string {
  return `${module}:${action}`;
}
