import { KeyRound, ScrollText } from 'lucide-react';
import type { NavItem } from './types';

const items: NavItem[] = [
  {
    labelKey: 'developer.credentials.navLabel',
    href: '/developer/credentials',
    icon: KeyRound,
    permission: 'api_clients:view',
  },
  {
    labelKey: 'developer.audit.navLabel',
    href: '/developer/audit',
    icon: ScrollText,
    permission: 'audit_log:view',
  },
];

export default items;
