import { setRequestLocale } from 'next-intl/server';
import { ExportsView } from './exports-view';

export default async function ExportsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <ExportsView />;
}
