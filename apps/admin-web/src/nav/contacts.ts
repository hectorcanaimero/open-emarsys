import { Database, Download, FileUp, ListChecks, SlidersHorizontal, Users } from 'lucide-react';
import type { NavItem } from './types';

const items: NavItem[] = [
  { labelKey: 'contacts-fields.nav.contacts', href: '/contacts', icon: Users, permission: 'contacts:view' },
  {
    labelKey: 'contacts-fields.nav.fields',
    href: '/contacts/fields',
    icon: SlidersHorizontal,
    permission: 'contacts:view',
  },
  {
    labelKey: 'contacts-fields.nav.lists',
    href: '/contacts/lists',
    icon: ListChecks,
    permission: 'contacts:view',
  },
  {
    labelKey: 'contacts-fields.nav.import',
    href: '/contacts/import',
    icon: FileUp,
    permission: 'contacts:view',
  },
  {
    labelKey: 'contacts-fields.nav.exports',
    href: '/contacts/exports',
    icon: Download,
    permission: 'contacts:view',
  },
  {
    labelKey: 'contacts-fields.nav.relational',
    href: '/contacts/relational',
    icon: Database,
    permission: 'contacts:view',
  },
];

export default items;
