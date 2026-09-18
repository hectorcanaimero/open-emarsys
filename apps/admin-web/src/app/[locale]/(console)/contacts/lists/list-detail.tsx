'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import {
  api,
  contactLabel,
  fullName,
  type Contact,
  type ContactList,
  type ListMember,
  type Page,
} from './api';

const PAGE_SIZE = 25;

export function ListDetail({ id }: { id: string }) {
  const t = useTranslations('contacts-lists');
  const [list, setList] = useState<ContactList | null>(null);
  const [members, setMembers] = useState<ListMember[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reloads the count and the first page of members; runs after every change.
  const load = useCallback(async () => {
    const [l, m] = await Promise.all([
      api<ContactList>('GET', `/lists/${id}`),
      api<Page<ListMember>>('GET', `/lists/${id}/members`, { query: { limit: PAGE_SIZE } }),
    ]);
    if (!l.data || !m.data) return setError(t('errors.load'));
    setList(l.data);
    setMembers(m.data.items);
    setCursor(m.data.next_cursor);
    setSelected([]);
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    const m = await api<Page<ListMember>>('GET', `/lists/${id}/members`, {
      query: { limit: PAGE_SIZE, cursor: cursor ?? undefined },
    });
    if (!m.data) return setError(t('errors.load'));
    const next = m.data;
    setMembers((prev) => [...prev, ...next.items]);
    setCursor(next.next_cursor);
  }

  async function search(e: FormEvent) {
    e.preventDefault();
    const res = await api<Page<Contact>>('GET', '/contacts', {
      query: { q: query.trim(), limit: 10 },
    });
    if (!res.data) return setError(t('errors.generic'));
    setError(null);
    setResults(res.data.items);
  }

  async function change(method: 'POST' | 'DELETE', ids: string[]) {
    const res = await api(method, `/lists/${id}/members`, { body: { contact_ids: ids } });
    if (!res.ok) return setError(t('errors.generic'));
    setError(null);
    await load();
  }

  const memberIds = new Set(members.map((m) => m.contact_id));
  const toggle = (cid: string) =>
    setSelected((prev) => (prev.includes(cid) ? prev.filter((x) => x !== cid) : [...prev, cid]));

  return (
    <div className="space-y-6">
      <Link href="/contacts/lists" className="text-sm underline">
        {t('detail.back')}
      </Link>
      <h1 className="text-2xl font-semibold">{list?.name ?? t('title')}</h1>
      {list && <p aria-live="polite">{t('detail.count', { count: list.member_count })}</p>}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <Link
        href={`/contacts/import?target=${encodeURIComponent(`list:${id}`)}`}
        className="inline-block underline"
      >
        {t('detail.import')}
      </Link>

      <section aria-labelledby="add-title" className="space-y-2">
        <h2 id="add-title" className="font-semibold">
          {t('add.title')}
        </h2>
        <form onSubmit={search} className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="contact-search" className="text-sm font-medium">
              {t('add.searchLabel')}
            </label>
            <input
              id="contact-search"
              required
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 rounded-md border px-3 text-sm"
            />
          </div>
          <Button type="submit">{t('add.search')}</Button>
        </form>
        {results && results.length === 0 && <p>{t('add.none')}</p>}
        {results && results.length > 0 && (
          <ul>
            {results.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-1">
                <span>
                  {contactLabel(c.fields)} ({String(c.fields['3'] ?? '')})
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={memberIds.has(c.id)}
                  onClick={() => change('POST', [c.id])}
                >
                  {t('add.action', { name: contactLabel(c.fields) })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="members-title" className="space-y-2">
        <h2 id="members-title" className="font-semibold">
          {t('members.title')}
        </h2>
        {members.length === 0 ? (
          <p>{t('members.empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">{t('members.title')}</caption>
            <thead>
              <tr className="text-left">
                <th scope="col" className="w-8">
                  <span className="sr-only">{t('members.select')}</span>
                </th>
                <th scope="col">{t('members.name')}</th>
                <th scope="col">{t('members.email')}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.contact_id} className="border-t">
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t('members.selectOne', { name: contactLabel(m.fields) })}
                      checked={selected.includes(m.contact_id)}
                      onChange={() => toggle(m.contact_id)}
                    />
                  </td>
                  <td>{fullName(m.fields)}</td>
                  <td>{String(m.fields['3'] ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex gap-2">
          <Button disabled={selected.length === 0} onClick={() => change('DELETE', selected)}>
            {t('members.removeSelected')}
          </Button>
          {cursor && (
            <Button variant="ghost" onClick={loadMore}>
              {t('members.loadMore')}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
