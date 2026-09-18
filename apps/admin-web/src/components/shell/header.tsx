'use client';

import { useTranslations } from 'next-intl';
import { LanguageSwitcher } from './language-switcher';
import { UserMenu } from './user-menu';

export function Header() {
  const t = useTranslations('common');

  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-4">
      <span className="font-semibold">{t('appName')}</span>
      <div className="flex items-center gap-2">
        <LanguageSwitcher />
        <UserMenu />
      </div>
    </header>
  );
}
