'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, fetchFields, fetchLists, type ContactList, type Field, type Job } from '../import/api';
import { JobView } from '../import/job-view';

const inputClass = 'mt-1 block rounded-md border border-input bg-transparent px-3 py-2 text-sm';
const live = (url: string | null, expires: string | null) => !!url && (!expires || new Date(expires) > new Date());

export function ExportsView() {
  const t = useTranslations('contactsImport.exports');
  const locale = useLocale();
  const format = useFormatter();

  const [fields, setFields] = useState<Field[]>([]);
  const [lists, setLists] = useState<ContactList[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [scope, setScope] = useState('all');
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [history, setHistory] = useState<Job[]>([]);

  const loadHistory = () =>
    api<{ items: Job[] }>('GET', '/jobs?limit=50')
      .then((r) => setHistory(r.items))
      .catch(() => setError('loadFailed'));

  useEffect(() => {
    Promise.all([fetchFields(), fetchLists()])
      .then(([f, l]) => {
        setFields(f);
        setLists(l);
      })
      .catch(() => setError('loadFailed'));
    loadHistory();
  }, []);

  async function create() {
    setError(null);
    if (selected.length === 0) return setError('noFields');
    try {
      const job = await api<Job>('POST', '/exports', { fields: selected, scope, format: 'csv' });
      setJobId(job.id);
      loadHistory();
    } catch {
      setError('createFailed');
    }
  }

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      )}

      <form
        className="mt-6 max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <fieldset>
          <legend className="text-sm font-medium">{t('fields')}</legend>
          {fields.map((f) => (
            <label key={f.field_id} className="mt-1 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selected.includes(f.field_id)} onChange={() => toggle(f.field_id)} />
              {f.labels[locale] ?? f.api_name}
            </label>
          ))}
        </fieldset>
        <label htmlFor="export-scope" className="mt-4 block text-sm font-medium">
          {t('scope')}
        </label>
        <select id="export-scope" className={inputClass} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">{t('scopeAll')}</option>
          {lists.map((l) => (
            <option key={l.id} value={`list:${l.id}`}>
              {l.name}
            </option>
          ))}
        </select>
        <Button type="submit" className="mt-4">
          {t('create')}
        </Button>
      </form>

      {jobId && (
        <div className="mt-6">
          <JobView jobId={jobId} />
        </div>
      )}

      <h2 className="mt-8 text-lg font-semibold">{t('history.title')}</h2>
      <table className="mt-2 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th scope="col" className="py-2 font-medium">{t('history.kind')}</th>
            <th scope="col" className="py-2 font-medium">{t('history.status')}</th>
            <th scope="col" className="py-2 font-medium">{t('history.created')}</th>
            <th scope="col" className="py-2 font-medium">{t('history.download')}</th>
          </tr>
        </thead>
        <tbody>
          {history.length === 0 && (
            <tr>
              <td colSpan={4} className="py-4 text-muted-foreground">
                {t('history.empty')}
              </td>
            </tr>
          )}
          {history.map((j) => (
            <tr key={j.id} className="border-b border-border">
              <td className="py-2">{t(`history.kinds.${j.kind}`)}</td>
              <td className="py-2">{t(`history.statuses.${j.status}`)}</td>
              <td className="py-2">{format.dateTime(new Date(j.created_at), { dateStyle: 'medium', timeStyle: 'short' })}</td>
              <td className="py-2">
                {live(j.result_url, j.result_url_expires_at) && (
                  <a className="underline" href={j.result_url!} download>
                    {t('history.downloadResult')}
                  </a>
                )}{' '}
                {live(j.error_report_url, j.error_report_url_expires_at) && (
                  <a className="underline" href={j.error_report_url!} download>
                    {t('history.downloadErrors')}
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
