'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { navItems } from '@/nav';
import { filterNavByPermission } from '@/nav/types';

export function Sidebar({ permissions = [] }: { permissions?: readonly string[] | null }) {
  const t = useTranslations('common');
  const items = filterNavByPermission(navItems, permissions);

  return (
    <nav aria-label={t('nav.mainLabel')} className="w-64 shrink-0 border-r border-border p-4">
      <ul className="space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
              >
                <Icon className="size-4" aria-hidden="true" />
                {t(item.labelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
