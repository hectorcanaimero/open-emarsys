'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, type Page, type RelationalRow, type RelationalTable } from '../relational/api';

/** One tab per relational table; renders nothing when there are no tables (or they can't load). */
export function RelationalPanel({ contactId }: { contactId: string }) {
  const t = useTranslations('contacts-relational');
  const [tables, setTables] = useState<RelationalTable[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [rows, setRows] = useState<RelationalRow[] | null>(null);

  useEffect(() => {
    api<Page<RelationalTable>>('GET', '/relational-tables', { query: { limit: 100 } })
      .then((r) => {
        setTables(r.data?.items ?? []);
        setActive(r.data?.items[0]?.id ?? null);
      })
      .catch(() => setTables([]));
  }, []);

  useEffect(() => {
    if (!active) return;
    setRows(null);
    api<Page<RelationalRow>>('GET', `/contacts/${contactId}/relational/${active}`, { query: { limit: 100 } })
      .then((r) => setRows(r.data?.items ?? []))
      .catch(() => setRows([]));
  }, [contactId, active]);

  const table = tables.find((x) => x.id === active);
  if (!table) return null;

  return (
    <section aria-labelledby="rel-title" className="space-y-3">
      <h2 id="rel-title" className="font-semibold">
        {t('panel.title')}
      </h2>
      <div role="tablist" aria-label={t('panel.title')} className="flex gap-2">
        {tables.map((tb) => (
          <button
            key={tb.id}
            role="tab"
            id={`rel-tab-${tb.id}`}
            type="button"
            aria-selected={tb.id === active}
            aria-controls="rel-tabpanel"
            tabIndex={tb.id === active ? 0 : -1}
            onClick={() => setActive(tb.id)}
            className={`rounded-md border px-3 py-1 text-sm ${tb.id === active ? 'font-semibold underline' : ''}`}
          >
            {tb.name}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="rel-tabpanel" aria-labelledby={`rel-tab-${table.id}`}>
        {rows === null ? (
          <p>{t('panel.loading')}</p>
        ) : rows.length === 0 ? (
          <p>{t('panel.empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">{table.name}</caption>
            <thead>
              <tr className="text-left">
                {table.columns.map((c) => (
                  <th key={c.name} scope="col">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t">
                  {table.columns.map((c) => {
                    const v = row.data[c.name];
                    return (
                      <td key={c.name}>
                        {v === null || v === undefined
                          ? t('panel.none')
                          : typeof v === 'boolean'
                            ? t(v ? 'panel.yes' : 'panel.no')
                            : String(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
