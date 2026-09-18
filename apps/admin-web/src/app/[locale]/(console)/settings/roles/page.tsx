import { setRequestLocale } from 'next-intl/server';
import { RolesScreen } from './roles-screen';

export default async function RolesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <RolesScreen />;
}
