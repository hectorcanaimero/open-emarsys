'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { api, COLUMN_TYPES, type Column, type ColumnType, type Page, type RelationalTable } from './api';

const input = 'h-9 rounded-md border px-3 text-sm';
const blank = (): Column => ({ name: '', type: 'text' });

function ColumnInputs({
  cols,
  onChange,
  prefix,
}: {
  cols: Column[];
  onChange: (c: Column[]) => void;
  prefix: string;
}) {
  const t = useTranslations('contacts-relational');
  const set = (i: number, patch: Partial<Column>) =>
    onChange(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <>
      {cols.map((c, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${prefix}-n${i}`} className="text-sm font-medium">
              {t('columns.name')} {i + 1}
            </label>
            <input
              id={`${prefix}-n${i}`}
              required
              pattern="[a-z][a-z0-9_]*"
              value={c.name}
              onChange={(e) => set(i, { name: e.target.value })}
              className={input}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${prefix}-t${i}`} className="text-sm font-medium">
              {t('columns.type')} {i + 1}
            </label>
            <select
              id={`${prefix}-t${i}`}
              value={c.type}
              onChange={(e) => set(i, { type: e.target.value as ColumnType })}
              className={input}
            >
              {COLUMN_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(`types.${ty}`)}
                </option>
              ))}
            </select>
          </div>
          {cols.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(cols.filter((_, j) => j !== i))}
            >
              {t('columns.remove', { n: i + 1 })}
            </Button>
          )}
        </div>
      ))}
      <Button type="button" size="sm" onClick={() => onChange([...cols, blank()])}>
        {t('columns.add')}
      </Button>
    </>
  );
}

export function RelationalScreen() {
  const t = useTranslations('contacts-relational');
  const [tables, setTables] = useState<RelationalTable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [cols, setCols] = useState<Column[]>([blank()]);
  const [key, setKey] = useState('');
  const [extra, setExtra] = useState<{ id: string; cols: Column[] } | null>(null);
  const [deleting, setDeleting] = useState<RelationalTable | null>(null);

  const load = useCallback(async () => {
    const r = await api<Page<RelationalTable>>('GET', '/relational-tables', { query: { limit: 100 } });
    if (!r.data) return setError(t('errors.load'));
    setTables(r.data.items);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function done(ok: boolean, status: number) {
    if (!ok) {
      setError(t(status === 409 ? 'errors.duplicate' : 'errors.generic'));
      return false;
    }
    setError(null);
    await load();
    return true;
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const res = await api('POST', '/relational-tables', {
      body: { name, key_field: key || cols[0]!.name, columns: cols },
    });
    if (await done(res.ok, res.status)) {
      setName('');
      setCols([blank()]);
      setKey('');
    }
  }

  async function addColumns(e: FormEvent) {
    e.preventDefault();
    const res = await api('PATCH', `/relational-tables/${extra!.id}`, {
      body: { add_columns: extra!.cols },
    });
    if (await done(res.ok, res.status)) setExtra(null);
  }

  async function remove() {
    const res = await api('DELETE', `/relational-tables/${deleting!.id}`);
    if (await done(res.ok, res.status)) setDeleting(null);
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <section aria-labelledby="rel-create" className="space-y-3">
        <h2 id="rel-create" className="font-semibold">
          {t('create.title')}
        </h2>
        <form onSubmit={create} className="space-y-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="rel-name" className="text-sm font-medium">
              {t('create.name')}
            </label>
            <input
              id="rel-name"
              required
              pattern="[a-z][a-z0-9_]*"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${input} max-w-xs`}
            />
          </div>
          <ColumnInputs cols={cols} onChange={setCols} prefix="new" />
          <div className="flex flex-col gap-1">
            <label htmlFor="rel-key" className="text-sm font-medium">
              {t('create.keyField')}
            </label>
            <select
              id="rel-key"
              value={key || cols[0]?.name || ''}
              onChange={(e) => setKey(e.target.value)}
              className={`${input} max-w-xs`}
            >
              {cols
                .filter((c) => c.name)
                .map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
          <Button type="submit">{t('create.submit')}</Button>
        </form>
      </section>

      {tables.length === 0 ? (
        <p>{t('empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">{t('title')}</caption>
          <thead>
            <tr className="text-left">
              <th scope="col">{t('list.name')}</th>
              <th scope="col">{t('list.columns')}</th>
              <th scope="col">{t('list.key')}</th>
              <th scope="col">{t('list.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((tb) => (
              <tr key={tb.id} className="border-t align-top">
                <th scope="row" className="text-left font-medium">
                  {tb.name}
                </th>
                <td>{tb.columns.map((c) => `${c.name} (${t(`types.${c.type}`)})`).join(', ')}</td>
                <td>{tb.key_field}</td>
                <td className="space-x-2">
                  <Button size="sm" onClick={() => setExtra({ id: tb.id, cols: [blank()] })}>
                    {t('list.addColumns', { name: tb.name })}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(tb)}>
                    {t('list.delete', { name: tb.name })}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {extra && (
        <section aria-labelledby="rel-extra" className="space-y-3">
          <h2 id="rel-extra" className="font-semibold">
            {t('extend.title')}
          </h2>
          <form onSubmit={addColumns} className="space-y-3">
            <ColumnInputs cols={extra.cols} onChange={(c) => setExtra({ ...extra, cols: c })} prefix="ext" />
            <div className="flex gap-2">
              <Button type="submit">{t('extend.submit')}</Button>
              <Button type="button" variant="ghost" onClick={() => setExtra(null)}>
                {t('cancel')}
              </Button>
            </div>
          </form>
        </section>
      )}

      {deleting && (
        <section
          role="alertdialog"
          aria-labelledby="rel-del"
          aria-describedby="rel-del-body"
          className="space-y-3 rounded-md border p-4"
        >
          <h2 id="rel-del" className="font-semibold">
            {t('delete.title')}
          </h2>
          <p id="rel-del-body">{t('delete.body', { name: deleting.name })}</p>
          <div className="flex gap-2">
            <Button onClick={remove}>{t('delete.confirm')}</Button>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
