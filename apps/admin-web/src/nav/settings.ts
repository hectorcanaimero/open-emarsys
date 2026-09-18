import { ShieldCheck, Users } from 'lucide-react';
import type { NavItem } from './types';

const items: NavItem[] = [
  {
    labelKey: 'settings.nav.users',
    href: '/settings/users',
    icon: Users,
    permission: 'users:view',
  },
  {
    labelKey: 'settings.nav.roles',
    href: '/settings/roles',
    icon: ShieldCheck,
    permission: 'roles:view',
  },
];

export default items;
