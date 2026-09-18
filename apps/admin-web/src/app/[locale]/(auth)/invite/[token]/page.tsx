import { getTranslations, setRequestLocale } from 'next-intl/server';
import { acceptInvitation } from './actions';
import { InviteForm } from './invite-form';

export default async function InvitePage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');

  return (
    <main id="main-content" className="mx-auto mt-24 w-full max-w-sm space-y-6 px-4">
      <h1 className="text-2xl font-semibold">{t('invite.title')}</h1>
      <p className="text-sm">{t('invite.description')}</p>
      <InviteForm action={acceptInvitation.bind(null, token)} />
    </main>
  );
}
