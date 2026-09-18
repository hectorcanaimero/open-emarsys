import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';

export default async function ConsoleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('common');
  const format = await getFormatter();

  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('dashboard.title')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t('dashboard.today', { date: format.dateTime(new Date(), 'short') })}
      </p>
    </div>
  );
}
