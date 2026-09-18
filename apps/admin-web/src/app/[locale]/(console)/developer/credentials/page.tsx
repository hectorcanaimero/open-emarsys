import { setRequestLocale } from 'next-intl/server';
import { CredentialsView } from './credentials-view';

export default async function CredentialsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <CredentialsView />;
}
