import { setRequestLocale } from 'next-intl/server';
import { ContactsScreen } from './_components/contacts-screen';

export default async function ContactsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <ContactsScreen />;
}
