import { setRequestLocale } from 'next-intl/server';
import { AuditView } from './audit-view';

export default async function AuditPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <AuditView />;
}
