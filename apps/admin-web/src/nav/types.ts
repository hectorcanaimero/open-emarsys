import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * Every feature registers its console navigation entries by exporting a
 * default `NavItem[]` from `src/nav/<feature>.ts` (C11). `scripts/codegen/nav.mjs`
 * scans the directory and generates the aggregated `src/nav/index.ts`.
 */
export interface NavItem {
  labelKey: string;
  href: string;
  icon: ComponentType<LucideProps>;
  /** `module:action` permission required to see the item, or null if public to any signed-in user. */
  permission: string | null;
}

/**
 * `null` means the caller isn't permission-restricted (e.g. platform operator).
 * Otherwise only items with no permission or with a granted permission show up.
 */
export function filterNavByPermission(
  items: readonly NavItem[],
  grantedPermissions: readonly string[] | null
): NavItem[] {
  if (grantedPermissions === null) return [...items];
  return items.filter(
    (item) => item.permission === null || grantedPermissions.includes(item.permission)
  );
}
