'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { api, type GdprRequest, type Page } from '../relational/api';

const POLL_MS = 2000;

/** GDPR access/erasure for one contact. The parent only mounts it for `contacts:admin`. */
export function GdprActions({ contactId, email }: { contactId: string; email: string }) {
  const t = useTranslations('contacts-relational');
  const [exportReq, setExportReq] = useState<GdprRequest | null>(null);
  const [typed, setTyped] = useState('');
  const [forgotten, setForgotten] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // While the export job is queued/running, poll the request list until it settles.
  const pending = exportReq && (exportReq.status === 'queued' || exportReq.status === 'running');
  const pendingId = exportReq?.id;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      const r = await api<Page<GdprRequest>>('GET', '/gdpr-requests', {
        query: { kind: 'export', limit: 20 },
      }).catch(() => null);
      const found = r?.data?.items.find((x) => x.id === pendingId);
      if (found) setExportReq(found);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, pendingId]);

  async function requestExport() {
    const res = await api<GdprRequest>('POST', `/contacts/${contactId}/gdpr/export`);
    if (!res.data) return setError(t('errors.generic'));
    setError(null);
    setExportReq(res.data);
  }

  async function forget(e: FormEvent) {
    e.preventDefault();
    if (typed !== email) return;
    const res = await api('POST', `/contacts/${contactId}/gdpr/forget`);
    if (!res.ok) return setError(t('errors.generic'));
    setError(null);
    setForgotten(true);
  }

  return (
    <section aria-labelledby="gdpr-title" className="space-y-4">
      <h2 id="gdpr-title" className="font-semibold">
        {t('actions.title')}
      </h2>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="space-y-2">
        <Button type="button" onClick={requestExport} disabled={!!pending}>
          {t('actions.export')}
        </Button>
        <div role="status" className="text-sm">
          {pending && t('actions.exportPending')}
          {exportReq?.status === 'failed' && t('actions.exportFailed')}
          {exportReq?.status === 'done' && exportReq.result_url && (
            <a href={exportReq.result_url} className="underline">
              {t('actions.exportLink')}
            </a>
          )}
        </div>
      </div>

      {forgotten ? (
        <p role="status" className="text-sm">
          {t('actions.forgetQueued')}
        </p>
      ) : (
        <form onSubmit={forget} className="space-y-2">
          <p id="forget-warning" className="text-sm">
            {t('actions.forgetWarning')}
          </p>
          <div className="flex flex-col gap-1">
            <label htmlFor="forget-email" className="text-sm font-medium">
              {t('actions.forgetLabel', { email })}
            </label>
            <input
              id="forget-email"
              autoComplete="off"
              aria-describedby="forget-warning"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="h-9 max-w-sm rounded-md border px-3 text-sm"
            />
          </div>
          <Button type="submit" disabled={typed !== email}>
            {t('actions.forget')}
          </Button>
        </form>
      )}
    </section>
  );
}
