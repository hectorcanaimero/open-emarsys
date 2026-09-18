import { setRequestLocale } from 'next-intl/server';
import { RelationalScreen } from './relational-screen';

export default async function RelationalPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <RelationalScreen />;
}
