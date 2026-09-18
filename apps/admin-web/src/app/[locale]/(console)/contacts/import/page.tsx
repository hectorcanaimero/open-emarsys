import { setRequestLocale } from 'next-intl/server';
import { ImportWizard } from './import-wizard';

export default async function ImportPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <ImportWizard />;
}
