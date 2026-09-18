import { setRequestLocale } from 'next-intl/server';
import { UsersScreen } from './users-screen';

export default async function UsersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <UsersScreen />;
}
