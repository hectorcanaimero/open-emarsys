import { setRequestLocale } from 'next-intl/server';
import { ListsScreen } from './lists-screen';

export default async function ListsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <ListsScreen />;
}
