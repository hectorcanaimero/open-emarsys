import { getTranslations, setRequestLocale } from 'next-intl/server';
import { safeNext } from '@/lib/session/next';
import { LoginForm } from './login-form';

export default async function LoginPage({
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
      <h1 className="text-2xl font-semibold">{t('login.title')}</h1>
      <LoginForm next={safeNext(typeof next === 'string' ? next : null, `/${locale}`)} />
    </main>
  );
}
