/** Permission modules a role can be granted (FR-2). Permissions are `module:action`. */
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

/** Mirrors the `identity.permission_action` enum. */
export const PERMISSION_ACTIONS = ['view', 'edit', 'launch', 'admin'] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
export type Permission = `${PermissionModule}:${PermissionAction}`;
