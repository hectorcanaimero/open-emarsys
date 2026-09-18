import { setRequestLocale } from 'next-intl/server';
import { ListDetail } from '../list-detail';

export default async function ListDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  return <ListDetail id={id} />;
}
