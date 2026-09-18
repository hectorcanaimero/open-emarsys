import { getTranslations, setRequestLocale } from 'next-intl/server';
import { confirmMfa, disableMfa, enrollMfa, updateLocale } from './actions';
import { SecurityPanel } from './security-panel';

export default async function SecurityPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('security.title')}</h1>
      <SecurityPanel actions={{ enrollMfa, confirmMfa, disableMfa, updateLocale }} />
    </div>
  );
}
