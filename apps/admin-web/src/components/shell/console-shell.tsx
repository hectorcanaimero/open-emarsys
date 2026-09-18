'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Header } from './header';
import { Sidebar } from './sidebar';

export function ConsoleShell({ children }: { children: ReactNode }) {
  const t = useTranslations('common');

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        {t('skipToContent')}
      </a>
      <Header />
      <div className="flex flex-1">
        <Sidebar />
        <main id="main-content" className="flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
