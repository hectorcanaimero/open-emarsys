import { setRequestLocale } from 'next-intl/server';
import { TenantsClient } from './tenants-client';

export default async function TenantsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <TenantsClient />;
}
