'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { api, LOCALES, type Field } from './api';
import { FieldForm, type FieldDraft } from './field-form';

export function FieldsScreen() {
  const t = useTranslations('contacts-fields');
  const [fields, setFields] = useState<Field[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ field?: Field } | null>(null);
  const [deleting, setDeleting] = useState<Field | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ items: Field[] }>('GET', '/fields');
    setLoadError(!res.data);
    if (res.data) setFields(res.data.items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(req: Promise<{ ok: boolean; status: number }>, conflictKey: string) {
    const { ok, status } = await req;
    setError(ok ? null : t(status === 409 ? conflictKey : 'errors.generic'));
    if (ok) await load();
    return ok;
  }

  async function save(draft: FieldDraft) {
    const field = form?.field;
    const ok = await run(
      field
        ? api('PATCH', `/fields/${field.field_id}`, {
            ...(field.is_system ? {} : { api_name: draft.api_name }),
            labels: draft.labels,
            ...(draft.choices.length ? { choices: draft.choices } : {}),
          })
        : api('POST', '/fields', draft.choices.length ? draft : { ...draft, choices: undefined }),
      'errors.duplicate'
    );
    if (ok) setForm(null);
  }

  async function confirmDelete() {
    if (!deleting) return;
    if (await run(api('DELETE', `/fields/${deleting.field_id}`), 'errors.inUse')) setDeleting(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        {!form && (
          <Button
            onClick={() => {
              setError(null);
              setForm({});
            }}
          >
            {t('create')}
          </Button>
        )}
      </div>

      {form && (
        <FieldForm
          key={form.field?.field_id ?? 'new'}
          field={form.field}
          error={error}
          onSubmit={save}
          onCancel={() => setForm(null)}
        />
      )}
      {!form && error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {loadError && (
        <p role="alert" className="text-sm text-red-700">
          {t('errors.load')}
        </p>
      )}

      {fields && fields.length === 0 && <p>{t('empty')}</p>}
      {fields && fields.length > 0 && (
        <table className="w-full text-sm">
          <caption className="sr-only">{t('title')}</caption>
          <thead>
            <tr className="text-left">
              <th scope="col">{t('columns.id')}</th>
              <th scope="col">{t('columns.apiName')}</th>
              <th scope="col">{t('columns.type')}</th>
              <th scope="col">{t('columns.labels')}</th>
              <th scope="col">{t('columns.unique')}</th>
              <th scope="col">{t('columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.field_id} className="border-t align-top">
                <td className="py-2">
                  <span className="font-mono">{f.field_id}</span>{' '}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void navigator.clipboard?.writeText(String(f.field_id))}
                  >
                    {t('copy', { id: f.field_id })}
                  </Button>
                </td>
                <td>
                  {f.api_name} <span className="text-xs">({t(f.is_system ? 'system' : 'custom')})</span>
                </td>
                <td>{t(`types.${f.type}`)}</td>
                <td>
                  {LOCALES.map((l) => (
                    <div key={l}>
                      <span className="uppercase">{l}</span>: {f.labels[l]}
                    </div>
                  ))}
                  {f.choices.length > 0 && (
                    <ul className="mt-1 text-xs">
                      {f.choices.map((c) => (
                        <li key={c.id}>
                          <span className="font-mono">{c.id}</span> · {c.labels.es} / {c.labels.pt} /{' '}
                          {c.labels.en}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{t(f.unique ? 'yes' : 'no')}</td>
                <td className="space-x-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setError(null);
                      setForm({ field: f });
                    }}
                  >
                    {t('edit', { name: f.api_name })}
                  </Button>
                  {!f.is_system && (
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(f)}>
                      {t('delete.action', { name: f.api_name })}
                    </Button>
                  )}
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
          <p id="delete-desc">
            {t('delete.body', { name: deleting.api_name, id: deleting.field_id })}
          </p>
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
