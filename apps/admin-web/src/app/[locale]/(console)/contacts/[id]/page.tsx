import { cookies } from 'next/headers';
import { setRequestLocale } from 'next-intl/server';
import { ACCESS_COOKIE } from '@/lib/session/constants';
import { ContactDetail } from './contact-detail';

/**
 * Permissions come from the `perms` claim of the session token. This only decides what the UI
 * shows; core enforces `contacts:admin` on every request regardless.
 */
function permissionsOf(jwt: string | undefined): string[] {
  try {
    const payload = jwt!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const { perms } = JSON.parse(atob(payload)) as { perms?: string[] };
    return Array.isArray(perms) ? perms : [];
  } catch {
    return [];
  }
}

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const permissions = permissionsOf((await cookies()).get(ACCESS_COOKIE)?.value);

  return <ContactDetail id={id} permissions={permissions} />;
}
