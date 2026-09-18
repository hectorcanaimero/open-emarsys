'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { api, type Job } from './api';

const ACTIVE = ['draft', 'queued', 'running'];
const POLL_MS = 2000;

/** Live view of one job: polls every 2 s until it leaves queued/running. */
export function JobView({ jobId }: { jobId: string }) {
  const t = useTranslations('contactsImport.job');
  const [job, setJob] = useState<Job | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await api<Job>('GET', `/jobs/${jobId}`);
        if (stop) return;
        setJob(next);
        setFailed(false);
        if (ACTIVE.includes(next.status)) timer = setTimeout(tick, POLL_MS);
      } catch {
        if (stop) return;
        setFailed(true);
        timer = setTimeout(tick, POLL_MS);
      }
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [jobId]);

  if (!job) {
    return failed ? (
      <p role="alert" className="text-sm text-destructive">
        {t('loadFailed')}
      </p>
    ) : (
      <p role="status">{t('loading')}</p>
    );
  }

  const { rows_read, rows_ok, rows_failed } = job.progress;
  const done = !ACTIVE.includes(job.status);

  return (
    <section aria-labelledby="job-title">
      <h2 id="job-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p role="status" className="mt-2 text-sm">
        {t(`status.${job.status}`)}
      </p>
      {!done && (
        <progress className="mt-2 w-full" aria-label={t('title')} max={100} />
      )}
      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-muted-foreground">{t('rowsRead')}</dt>
          <dd>{rows_read}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('rowsOk')}</dt>
          <dd>{rows_ok}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('rowsFailed')}</dt>
          <dd>{rows_failed}</dd>
        </div>
      </dl>
      {job.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {job.error}
        </p>
      )}
      {done && job.result_url && (
        <a className="mt-3 block text-sm underline" href={job.result_url} download>
          {t('downloadResult')}
        </a>
      )}
      {done && job.error_report_url && (
        <a className="mt-3 inline-block text-sm underline" href={job.error_report_url} download>
          {t('downloadErrors', { count: rows_failed })}
        </a>
      )}
    </section>
  );
}
