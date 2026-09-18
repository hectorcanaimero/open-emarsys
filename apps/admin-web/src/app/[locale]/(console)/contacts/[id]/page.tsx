import { setRequestLocale } from 'next-intl/server';
import { ContactDetail } from './contact-detail';

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  return <ContactDetail id={id} />;
}
