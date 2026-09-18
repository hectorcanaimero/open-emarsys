'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { api, type GdprRequest, type Page } from '../relational/api';

export function GdprScreen() {
  const t = useTranslations('contacts-relational');
  const format = useFormatter();
  const [items, setItems] = useState<GdprRequest[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api<Page<GdprRequest>>('GET', '/gdpr-requests', { query: { limit: 100 } }).then((r) =>
      r.data ? setItems(r.data.items) : setError(true)
    );
  }, []);

  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), 'shortWithTime') : t('gdpr.none');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('gdpr.title')}</h1>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {t('errors.load')}
        </p>
      )}
      {items && items.length === 0 && <p>{t('gdpr.empty')}</p>}
      {items && items.length > 0 && (
        <table className="w-full text-sm">
          <caption className="sr-only">{t('gdpr.title')}</caption>
          <thead>
            <tr className="text-left">
              <th scope="col">{t('gdpr.kind')}</th>
              <th scope="col">{t('gdpr.status')}</th>
              <th scope="col">{t('gdpr.requested')}</th>
              <th scope="col">{t('gdpr.completed')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-t">
                <td>{t(`gdpr.kinds.${r.kind}`)}</td>
                <td>{t(`gdpr.statuses.${r.status}`)}</td>
                <td>{when(r.requested_at)}</td>
                <td>{when(r.completed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
