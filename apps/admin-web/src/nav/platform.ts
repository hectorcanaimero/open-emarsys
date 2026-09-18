import { Building2 } from 'lucide-react';
import type { NavItem } from './types';

// Gate is the operator-wide `platform:admin` permission, not the endpoint-level
// `tenants:view`/`tenants:admin` from the contract — only operators managing the
// platform itself should ever see this entry.
const items: NavItem[] = [
  { labelKey: 'nav.tenants', href: '/platform/tenants', icon: Building2, permission: 'platform:admin' },
];

export default items;
