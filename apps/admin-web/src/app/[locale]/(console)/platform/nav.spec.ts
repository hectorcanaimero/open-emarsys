import { describe, expect, it } from 'vitest';
import { filterNavByPermission } from '@/nav/types';
import platformNav from '@/nav/platform';

describe('platform nav', () => {
  it('requires the platform:admin permission', () => {
    expect(platformNav).toEqual([
      expect.objectContaining({ href: '/platform/tenants', permission: 'platform:admin' }),
    ]);
  });

  it('is hidden for a user without platform:admin', () => {
    expect(filterNavByPermission(platformNav, ['tenants:view', 'tenants:admin'])).toEqual([]);
  });

  it('is shown for a user with platform:admin', () => {
    expect(filterNavByPermission(platformNav, ['platform:admin'])).toEqual(platformNav);
  });
});
