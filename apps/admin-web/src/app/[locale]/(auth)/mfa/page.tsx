import { getTranslations, setRequestLocale } from 'next-intl/server';
import { safeNext } from '@/lib/session/next';
import { MfaForm } from './mfa-form';

export default async function MfaPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { next } = await searchParams;
  const t = await getTranslations('auth');

  return (
    <main id="main-content" className="mx-auto mt-24 w-full max-w-sm space-y-6 px-4">
      <h1 className="text-2xl font-semibold">{t('mfa.title')}</h1>
      <p className="text-sm">{t('mfa.description')}</p>
      <MfaForm next={safeNext(typeof next === 'string' ? next : null, `/${locale}`)} />
    </main>
  );
}
