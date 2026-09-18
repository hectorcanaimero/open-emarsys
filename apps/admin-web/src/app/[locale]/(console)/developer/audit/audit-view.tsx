'use client';

import type { components } from '@oe/ts-contracts/openapi/identity';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { createApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Dialog } from '../dialog';

type AuditEntry = components['schemas']['AuditEntry'];

export function AuditView() {
  const t = useTranslations('developer.audit');

  const [actorId, setActorId] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [detail, setDetail] = useState<AuditEntry | null>(null);

  const loadEntries = useCallback(
    async (cursor?: string) => {
      const { data, error } = await createApiClient().GET('/audit-log', {
        params: {
          query: {
            ...(cursor ? { cursor } : {}),
            ...(actorId ? { actor_id: actorId } : {}),
            ...(resourceType ? { resource_type: resourceType } : {}),
            ...(from ? { from: new Date(from).toISOString() } : {}),
            ...(to ? { to: new Date(to).toISOString() } : {}),
          },
        },
      });
      if (error) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      setEntries((prev) => (cursor ? [...prev, ...data.items] : data.items));
      setNextCursor(data.next_cursor);
    },
    [actorId, resourceType, from, to]
  );

  useEffect(() => {
    loadEntries();
    // Intentionally run once on mount; `applyFilters`/`resetFilters` re-fetch explicitly.
  }, []);

  function applyFilters() {
    loadEntries();
  }

  function resetFilters() {
    setActorId('');
    setResourceType('');
    setFrom('');
    setTo('');
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>

      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <div>
          <label htmlFor="filter-actor" className="block text-sm font-medium">
            {t('filters.actor')}
          </label>
          <input
            id="filter-actor"
            value={actorId}
            onChange={(event) => setActorId(event.target.value)}
            className="mt-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="filter-resource-type" className="block text-sm font-medium">
            {t('filters.resourceType')}
          </label>
          <input
            id="filter-resource-type"
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value)}
            className="mt-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="filter-from" className="block text-sm font-medium">
            {t('filters.from')}
          </label>
          <input
            id="filter-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="mt-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="filter-to" className="block text-sm font-medium">
            {t('filters.to')}
          </label>
          <input
            id="filter-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="mt-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <Button type="submit">{t('filters.apply')}</Button>
        <Button type="button" variant="ghost" onClick={resetFilters}>
          {t('filters.reset')}
        </Button>
      </form>

      {loadError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {t('errors.loadFailed')}
        </p>
      )}

      <table className="mt-6 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="py-2 font-medium">{t('table.occurredAt')}</th>
            <th className="py-2 font-medium">{t('table.actor')}</th>
            <th className="py-2 font-medium">{t('table.action')}</th>
            <th className="py-2 font-medium">{t('table.resourceType')}</th>
            <th className="py-2 font-medium">
              <span className="sr-only">{t('table.details')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && !loadError && (
            <tr>
              <td colSpan={5} className="py-4 text-muted-foreground">
                {t('empty')}
              </td>
            </tr>
          )}
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-border">
              <td className="py-2">{entry.occurred_at}</td>
              <td className="py-2">{entry.actor_id}</td>
              <td className="py-2">{entry.action}</td>
              <td className="py-2">{entry.resource_type}</td>
              <td className="py-2 text-right">
                <Button variant="ghost" size="sm" onClick={() => setDetail(entry)}>
                  {t('table.details')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {nextCursor && (
        <Button variant="ghost" className="mt-4" onClick={() => loadEntries(nextCursor)}>
          {t('loadMore')}
        </Button>
      )}

      <Dialog open={detail !== null} onClose={() => setDetail(null)} titleId="audit-detail-title">
        {detail && (
          <>
            <h2 id="audit-detail-title" className="text-lg font-semibold">
              {t('detailDialog.title')}
            </h2>

            {detail.changes ? (
              <table className="mt-4 w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-2 font-medium">{t('detailDialog.field')}</th>
                    <th className="py-2 font-medium">{t('detailDialog.before')}</th>
                    <th className="py-2 font-medium">{t('detailDialog.after')}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(detail.changes).map(([field, change]) => {
                    const { before, after } = change as { before: unknown; after: unknown };
                    return (
                      <tr key={field}>
                        <td className="py-2 font-mono text-xs">{field}</td>
                        <td className="py-2 text-xs">{JSON.stringify(before)}</td>
                        <td className="py-2 text-xs">{JSON.stringify(after)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">{t('detailDialog.noChanges')}</p>
            )}

            <div className="mt-6 flex justify-end">
              <Button onClick={() => setDetail(null)}>{t('detailDialog.close')}</Button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
