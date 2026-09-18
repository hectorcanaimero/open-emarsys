import { render } from '@testing-library/react';
import { axe } from 'jest-axe';
import { LayoutDashboard } from 'lucide-react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { filterNavByPermission, type NavItem } from '@/nav/types';
import commonEs from '../../../messages/es/common.json';
import { ConsoleShell } from './console-shell';

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'es' }),
  usePathname: () => '/',
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

function renderShell() {
  return render(
    <NextIntlClientProvider locale="es" messages={{ common: commonEs }}>
      <ConsoleShell>
        <p>Content</p>
      </ConsoleShell>
    </NextIntlClientProvider>
  );
}

describe('ConsoleShell', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderShell();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('exposes a skip link and the main landmarks', () => {
    const { getByRole } = renderShell();

    expect(getByRole('link', { name: commonEs.skipToContent })).toHaveAttribute(
      'href',
      '#main-content'
    );
    expect(getByRole('banner')).toBeInTheDocument();
    expect(getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(getByRole('navigation', { name: commonEs.nav.mainLabel })).toBeInTheDocument();
  });
});

describe('filterNavByPermission', () => {
  const items: NavItem[] = [
    { labelKey: 'a', href: '/a', icon: LayoutDashboard, permission: null },
    { labelKey: 'b', href: '/b', icon: LayoutDashboard, permission: 'contacts:view' },
  ];

  it('keeps items that require no permission', () => {
    expect(filterNavByPermission(items, [])).toEqual([items[0]]);
  });

  it('keeps items whose permission is granted', () => {
    expect(filterNavByPermission(items, ['contacts:view'])).toEqual(items);
  });

  it('keeps everything when the caller is not permission-restricted', () => {
    expect(filterNavByPermission(items, null)).toEqual(items);
  });
});
