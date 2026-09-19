'use client';

import Papa from 'papaparse';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  api,
  fetchFields,
  fetchLists,
  fetchTables,
  uploadFile,
  type ContactList,
  type Field,
  type ImportPreview,
  type Job,
  type RelationalTable,
} from './api';
import { JobView } from './job-view';

const STEPS = ['upload', 'settings', 'mapping', 'confirm', 'job'] as const;
type Step = (typeof STEPS)[number];
type Mode = 'create' | 'update' | 'upsert';
const IGNORE = '';

const inputClass = 'mt-1 block rounded-md border border-input bg-transparent px-3 py-2 text-sm';

function PreviewTable({ columns, rows, caption }: { columns: string[]; rows: string[][]; caption: string }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="mb-1 text-left text-muted-foreground">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            {columns.map((c, i) => (
              <th key={i} scope="col" className="py-1 pr-3 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border">
              {r.map((cell, j) => (
                <td key={j} className="py-1 pr-3">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ImportWizard() {
  const t = useTranslations('contacts-import.wizard');
  const locale = useLocale();

  const [step, setStep] = useState<Step>('upload');
  const [error, setError] = useState<string | null>(null);

  // upload
  const [file, setFile] = useState<File | null>(null);
  const [local, setLocal] = useState<string[][]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  // `/start` enqueues a job with its own id; the draft id above is not a job.
  const [jobId, setJobId] = useState<string | null>(null);

  // settings
  const [fields, setFields] = useState<Field[]>([]);
  const [lists, setLists] = useState<ContactList[]>([]);
  const [tables, setTables] = useState<RelationalTable[]>([]);
  const [targetKind, setTargetKind] = useState<'contacts' | 'list' | 'relational'>('contacts');
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<Mode>('upsert');
  const [keyId, setKeyId] = useState('3');

  // mapping: csv column -> destination ('' = ignore)
  const [mapping, setMapping] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([fetchFields(), fetchLists(), fetchTables()])
      .then(([f, l, r]) => {
        setFields(f);
        setLists(l);
        setTables(r);
        setTargetId((cur) => cur || l[0]?.id || '');
      })
      .catch(() => setError('loadFailed'));
  }, []);

  const target = targetKind === 'contacts' ? 'contacts' : `${targetKind}:${targetId}`;
  const table = targetKind === 'relational' ? tables.find((x) => x.id === targetId) : undefined;
  const destinations =
    targetKind === 'relational'
      ? (table?.columns ?? []).map((c) => ({ value: c.name, label: c.name }))
      : [
          { value: 'id', label: t('mapping.internalId') },
          ...fields.map((f) => ({ value: String(f.field_id), label: `${f.labels[locale] ?? f.api_name} (${f.api_name})` })),
        ];
  const keyOptions = [{ value: 'id', label: t('mapping.internalId') }].concat(
    fields.filter((f) => f.unique).map((f) => ({ value: String(f.field_id), label: f.labels[locale] ?? f.api_name }))
  );

  function pickFile(f: File | null) {
    setFile(f);
    setLocal([]);
    if (f) Papa.parse<string[]>(f, { preview: 5, skipEmptyLines: true, complete: (r) => setLocal(r.data) });
  }

  async function upload() {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const up = await api<{ url: string; object_key: string }>('POST', '/imports/upload-url', {
        filename: file.name,
        content_type: file.type || 'text/csv',
      });
      await uploadFile(up.url, file, setProgress);
      const job = await api<Job>('POST', '/imports', { object_key: up.object_key, filename: file.name });
      const pv = await api<ImportPreview>('POST', `/imports/${job.id}/preview`);
      setImportId(job.id);
      setPreview(pv);
      setStep('settings');
    } catch {
      setError('uploadFailed');
    } finally {
      setProgress(null);
    }
  }

  function goMapping() {
    if (!preview) return;
    // Suggest by api_name or label (any locale), case-insensitive; relational by column name.
    const norm = (s: string) => s.trim().toLowerCase();
    const next: Record<string, string> = {};
    for (const col of preview.columns) {
      const hit =
        targetKind === 'relational'
          ? destinations.find((d) => norm(d.value) === norm(col))
          : fields.find(
              (f) => norm(f.api_name) === norm(col) || Object.values(f.labels).some((l) => norm(l) === norm(col))
            );
      next[col] = hit ? ('field_id' in hit ? String(hit.field_id) : hit.value) : IGNORE;
    }
    setMapping(next);
    setError(null);
    setStep('mapping');
  }

  const chosen = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== IGNORE));

  function goConfirm() {
    if (Object.keys(chosen).length === 0) return setError('noMapping');
    if (targetKind !== 'relational' && !Object.values(chosen).includes(keyId)) return setError('keyUnmapped');
    setError(null);
    setStep('confirm');
  }

  async function start() {
    if (!importId || !preview) return;
    setError(null);
    try {
      const job = await api<Job>('POST', `/imports/${importId}/start`, {
        delimiter: preview.delimiter,
        encoding: preview.encoding,
        has_header: preview.has_header,
        mapping: chosen,
        key_id: keyId,
        mode,
        target,
      });
      setJobId(job.id);
      setStep('job');
    } catch {
      setError('startFailed');
    }
  }

  const canLeaveSettings = targetKind === 'contacts' || targetId !== '';

  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ol aria-label={t('stepsLabel')} className="mt-4 flex flex-wrap gap-4 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={s === step ? 'step' : undefined} className={s === step ? 'font-semibold' : 'text-muted-foreground'}>
            {i + 1}. {t(`steps.${s}`)}
          </li>
        ))}
      </ol>

      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      )}

      <div className="mt-6">
        {step === 'upload' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              upload();
            }}
          >
            <label htmlFor="csv-file" className="block text-sm font-medium">
              {t('upload.file')}
            </label>
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              className={inputClass}
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            {local.length > 0 && (
              <PreviewTable columns={local[0] ?? []} rows={local.slice(1)} caption={t('upload.localPreview')} />
            )}
            {progress !== null && (
              <div className="mt-3">
                <label htmlFor="upload-progress" className="text-sm">
                  {t('upload.progress', { pct: progress })}
                </label>
                <progress id="upload-progress" className="block w-full" value={progress} max={100} />
              </div>
            )}
            <Button type="submit" className="mt-4" disabled={!file || progress !== null}>
              {t('upload.submit')}
            </Button>
          </form>
        )}

        {step === 'settings' && preview && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              goMapping();
            }}
          >
            <PreviewTable columns={preview.columns} rows={preview.rows.slice(0, 5)} caption={t('settings.serverPreview')} />
            <div className="mt-4 grid max-w-md gap-4">
              <div>
                <label htmlFor="target-kind" className="block text-sm font-medium">
                  {t('settings.target')}
                </label>
                <select id="target-kind" className={inputClass} value={targetKind} onChange={(e) => {
                  const k = e.target.value as typeof targetKind;
                  setTargetKind(k);
                  setTargetId(k === 'list' ? (lists[0]?.id ?? '') : k === 'relational' ? (tables[0]?.id ?? '') : '');
                }}>
                  <option value="contacts">{t('settings.targets.contacts')}</option>
                  <option value="list">{t('settings.targets.list')}</option>
                  <option value="relational">{t('settings.targets.relational')}</option>
                </select>
              </div>
              {targetKind !== 'contacts' && (
                <div>
                  <label htmlFor="target-id" className="block text-sm font-medium">
                    {t(targetKind === 'list' ? 'settings.list' : 'settings.table')}
                  </label>
                  <select id="target-id" className={inputClass} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                    {(targetKind === 'list' ? lists : tables).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label htmlFor="mode" className="block text-sm font-medium">
                  {t('settings.mode')}
                </label>
                <select id="mode" className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                  {(['create', 'update', 'upsert'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`settings.modes.${m}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="key-id" className="block text-sm font-medium">
                  {t('settings.keyId')}
                </label>
                <select id="key-id" className={inputClass} value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                  {keyOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Button type="submit" className="mt-4" disabled={!canLeaveSettings}>
              {t('next')}
            </Button>
          </form>
        )}

        {step === 'mapping' && preview && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              goConfirm();
            }}
          >
            <p className="text-sm text-muted-foreground">{t('mapping.help')}</p>
            <div className="mt-3 grid max-w-xl gap-3">
              {preview.columns.map((col, i) => (
                <div key={col} className="flex items-center justify-between gap-4">
                  <label htmlFor={`map-${i}`} className="text-sm font-medium">
                    {col}
                  </label>
                  <select
                    id={`map-${i}`}
                    className={inputClass}
                    value={mapping[col] ?? IGNORE}
                    onChange={(e) => setMapping((m) => ({ ...m, [col]: e.target.value }))}
                  >
                    <option value={IGNORE}>{t('mapping.ignore')}</option>
                    {destinations.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setStep('settings')}>
                {t('back')}
              </Button>
              <Button type="submit">{t('next')}</Button>
            </div>
          </form>
        )}

        {step === 'confirm' && (
          <div>
            <h2 className="text-lg font-semibold">{t('confirm.title')}</h2>
            <dl className="mt-3 grid max-w-md grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">{t('confirm.file')}</dt>
              <dd>{file?.name}</dd>
              <dt className="text-muted-foreground">{t('settings.target')}</dt>
              <dd>{t(`settings.targets.${targetKind}`)}</dd>
              <dt className="text-muted-foreground">{t('settings.mode')}</dt>
              <dd>{t(`settings.modes.${mode}`)}</dd>
              <dt className="text-muted-foreground">{t('settings.keyId')}</dt>
              <dd>{keyOptions.find((o) => o.value === keyId)?.label}</dd>
              <dt className="text-muted-foreground">{t('confirm.columns')}</dt>
              <dd>{Object.keys(chosen).length}</dd>
            </dl>
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setStep('mapping')}>
                {t('back')}
              </Button>
              <Button onClick={start}>{t('confirm.start')}</Button>
            </div>
          </div>
        )}

        {step === 'job' && jobId && <JobView jobId={jobId} />}
      </div>
    </div>
  );
}
