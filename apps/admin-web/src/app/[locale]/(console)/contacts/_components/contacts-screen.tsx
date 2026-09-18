'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { api, type Page } from '../lists/api';
import type { Contact, Field, Locale } from './types';

const ROW_HEIGHT = 40;
const VIEWPORT = 400;
const OVERSCAN = 5;
const PAGE_SIZE = 50;
const COLUMNS = [1, 2, 3, 4];
const OPS = ['eq', 'neq', 'contains', 'starts_with', 'gt', 'lt', 'empty', 'not_empty'] as const;

export function ContactsScreen() {
  const t = useTranslations('contacts-detail');
  const locale = useLocale() as Locale;
  const [fields, setFields] = useState<Field[]>([]);
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState({ field: '', op: 'eq', value: '' });
  const [rows, setRows] = useState<Contact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [add, setAdd] = useState({ email: '', first: '', last: '' });
  const [reload, setReload] = useState(0);
  const seq = useRef(0);

  // Debounce: the query only follows the input after 300 ms without typing.
  useEffect(() => {
    const id = setTimeout(() => setQ(input.trim()), 300);
    return () => clearTimeout(id);
  }, [input]);

  useEffect(() => {
    void api<{ items: Field[] }>('GET', '/fields').then((r) => r.data && setFields(r.data.items));
  }, []);

  const search = useCallback(
    async (cur?: string) => {
      const mine = ++seq.current;
      const noValue = filter.op === 'empty' || filter.op === 'not_empty';
      const res = await api<Page<Contact>>('GET', '/contacts', {
        query: {
          q,
          fields: COLUMNS.join(','),
          limit: PAGE_SIZE,
          cursor: cur,
          filters:
            filter.field && (noValue || filter.value)
              ? `${filter.field}:${filter.op}:${noValue ? '' : filter.value}`
              : undefined,
        },
      });
      if (mine !== seq.current) return; // a newer search superseded this one
      if (!res.data) return setError(t('errors.load'));
      const page = res.data;
      setError(null);
      setLoaded(true);
      setRows((prev) => (cur ? [...prev, ...page.items] : page.items));
      setCursor(page.next_cursor);
    },
    // `reload` is not read inside: it only re-creates `search` after a quick add.
    [q, filter, t, reload]
  );

  useEffect(() => {
    setScrollTop(0);
    void search();
  }, [search]);

  async function quickAdd(e: FormEvent) {
    e.preventDefault();
    const data: Record<string, string> = { '3': add.email.trim() };
    if (add.first.trim()) data['1'] = add.first.trim();
    if (add.last.trim()) data['2'] = add.last.trim();
    const res = await api('POST', '/contacts', { body: { fields: data } });
    if (!res.ok) return setError(t(res.status === 409 ? 'errors.duplicate' : 'errors.generic'));
    setAdd({ email: '', first: '', last: '' });
    setError(null);
    setReload((n) => n + 1);
  }

  const label = (id: number) => fields.find((f) => f.field_id === id)?.labels[locale] ?? `#${id}`;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + VIEWPORT) / ROW_HEIGHT) + OVERSCAN);
  const cell = (c: Contact, id: number) => String(c.fields[String(id)] ?? '');
  const inputCls = 'h-9 rounded-md border px-3 text-sm';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('list.title')}</h1>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="contact-q" className="text-sm font-medium">
            {t('list.search')}
          </label>
          <input
            id="contact-q"
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className={inputCls}
          />
        </div>
        <fieldset className="flex flex-wrap items-end gap-2">
          <legend className="text-sm font-medium">{t('list.filter.title')}</legend>
          <select
            aria-label={t('list.filter.field')}
            value={filter.field}
            onChange={(e) => setFilter({ ...filter, field: e.target.value })}
            className={inputCls}
          >
            <option value="">{t('list.filter.none')}</option>
            {fields.map((f) => (
              <option key={f.field_id} value={f.field_id}>
                {f.labels[locale]}
              </option>
            ))}
          </select>
          <select
            aria-label={t('list.filter.op')}
            value={filter.op}
            onChange={(e) => setFilter({ ...filter, op: e.target.value })}
            className={inputCls}
          >
            {OPS.map((op) => (
              <option key={op} value={op}>
                {t(`list.filter.ops.${op}`)}
              </option>
            ))}
          </select>
          <input
            aria-label={t('list.filter.value')}
            value={filter.value}
            onChange={(e) => setFilter({ ...filter, value: e.target.value })}
            className={inputCls}
          />
        </fieldset>
      </div>

      <div className="space-y-2">
        {loaded && rows.length === 0 ? (
          <p>{t('list.empty')}</p>
        ) : (
          // ponytail: fixed-height windowing (no dependency); switch to @tanstack/react-virtual
          // if rows ever need variable heights.
          <div
            role="region"
            aria-label={t('list.results')}
            // A scrollable region must be keyboard-focusable (axe: scrollable-region-focusable).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className="overflow-auto rounded-md border"
            style={{ height: VIEWPORT }}
            onScroll={(e) => {
              const el = e.currentTarget;
              setScrollTop(el.scrollTop);
              if (cursor && el.scrollTop + VIEWPORT >= el.scrollHeight - ROW_HEIGHT * 3)
                void search(cursor);
            }}
          >
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className="text-left">
                  {COLUMNS.map((id) => (
                    <th key={id} scope="col" className="px-2">
                      {label(id)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {first > 0 && (
                  <tr aria-hidden="true" style={{ height: first * ROW_HEIGHT }}>
                    <td colSpan={COLUMNS.length} />
                  </tr>
                )}
                {rows.slice(first, last).map((c) => (
                  <tr key={c.id} className="border-t" style={{ height: ROW_HEIGHT }}>
                    {COLUMNS.map((id, i) => (
                      <td key={id} className="px-2">
                        {i === 2 ? (
                          <Link href={`/contacts/${c.id}`} className="underline">
                            {cell(c, id) || c.id}
                          </Link>
                        ) : (
                          cell(c, id)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
                {last < rows.length && (
                  <tr aria-hidden="true" style={{ height: (rows.length - last) * ROW_HEIGHT }}>
                    <td colSpan={COLUMNS.length} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <Button variant="ghost" onClick={() => search(cursor)}>
            {t('list.loadMore')}
          </Button>
        )}
      </div>

      <section aria-labelledby="add-title" className="space-y-2">
        <h2 id="add-title" className="font-semibold">
          {t('list.add.title')}
        </h2>
        <form onSubmit={quickAdd} className="flex flex-wrap items-end gap-2">
          {(
            [
              ['email', 'email', true],
              ['first', 'text', false],
              ['last', 'text', false],
            ] as const
          ).map(([key, type, required]) => (
            <div key={key} className="flex flex-col gap-1">
              <label htmlFor={`add-${key}`} className="text-sm font-medium">
                {t(`list.add.${key}`)}
              </label>
              <input
                id={`add-${key}`}
                type={type}
                required={required}
                value={add[key]}
                onChange={(e) => setAdd({ ...add, [key]: e.target.value })}
                className={inputCls}
              />
            </div>
          ))}
          <Button type="submit">{t('list.add.submit')}</Button>
        </form>
      </section>
    </div>
  );
}
