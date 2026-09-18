'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { api, type ContactList, type Page } from './api';

export function ListsScreen() {
  const t = useTranslations('contacts-lists');
  const [lists, setLists] = useState<ContactList[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<ContactList | null>(null);

  const load = useCallback(async () => {
    const res = await api<Page<ContactList>>('GET', '/lists', { query: { limit: 200 } });
    setLoadError(!res.data);
    if (res.data) setLists(res.data.items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(req: Promise<{ ok: boolean; status: number }>) {
    const { ok, status } = await req;
    setError(ok ? null : t(status === 409 ? 'errors.duplicate' : 'errors.generic'));
    if (ok) await load();
    return ok;
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (await run(api('POST', '/lists', { body: { name: name.trim() } }))) setName('');
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    if (await run(api('PATCH', `/lists/${renaming.id}`, { body: { name: renaming.name.trim() } })))
      setRenaming(null);
  }

  async function confirmDelete() {
    if (!deleting) return;
    if (await run(api('DELETE', `/lists/${deleting.id}`))) setDeleting(null);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      <form onSubmit={create} className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="new-list-name" className="text-sm font-medium">
            {t('create.nameLabel')}
          </label>
          <input
            id="new-list-name"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 rounded-md border px-3 text-sm"
          />
        </div>
        <Button type="submit">{t('create.submit')}</Button>
      </form>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {loadError && (
        <p role="alert" className="text-sm text-red-700">
          {t('errors.load')}
        </p>
      )}

      {lists && lists.length === 0 && <p>{t('empty')}</p>}
      {lists && lists.length > 0 && (
        <table className="w-full text-sm">
          <caption className="sr-only">{t('title')}</caption>
          <thead>
            <tr className="text-left">
              <th scope="col">{t('columns.name')}</th>
              <th scope="col">{t('columns.members')}</th>
              <th scope="col">{t('columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((list) => (
              <tr key={list.id} className="border-t">
                <td className="py-2">
                  {renaming?.id === list.id ? (
                    <form onSubmit={rename} className="flex gap-2">
                      <label htmlFor="rename-list" className="sr-only">
                        {t('rename.label')}
                      </label>
                      <input
                        id="rename-list"
                        required
                        maxLength={200}
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: list.id, name: e.target.value })}
                        className="h-8 rounded-md border px-2"
                      />
                      <Button type="submit" size="sm">
                        {t('rename.save')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenaming(null)}
                      >
                        {t('cancel')}
                      </Button>
                    </form>
                  ) : (
                    <Link href={`/contacts/lists/${list.id}`} className="underline">
                      {list.name}
                    </Link>
                  )}
                </td>
                <td>{list.member_count}</td>
                <td className="space-x-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRenaming({ id: list.id, name: list.name })}
                  >
                    {t('rename.action', { name: list.name })}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(list)}>
                    {t('delete.action', { name: list.name })}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {deleting && (
        <div
          role="alertdialog"
          aria-labelledby="delete-title"
          aria-describedby="delete-desc"
          className="rounded-md border p-4"
        >
          <h2 id="delete-title" className="font-semibold">
            {t('delete.title')}
          </h2>
          <p id="delete-desc">{t('delete.body', { name: deleting.name })}</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={confirmDelete}>{t('delete.confirm')}</Button>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
