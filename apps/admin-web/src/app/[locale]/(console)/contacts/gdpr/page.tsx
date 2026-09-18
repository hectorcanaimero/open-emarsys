import { setRequestLocale } from 'next-intl/server';
import { GdprScreen } from './gdpr-screen';

export default async function GdprPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <GdprScreen />;
}
