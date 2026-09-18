import { setRequestLocale } from 'next-intl/server';
import { FieldsScreen } from './fields-screen';

export default async function FieldsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <FieldsScreen />;
}
