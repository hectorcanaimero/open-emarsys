'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { api, type Page } from '../lists/api';
import {
  CONSENT_FIELD_IDS,
  type Consent,
  type ConsentChannel,
  type ContactProfile,
  type Field,
  type FieldValue,
  type Locale,
} from '../_components/types';

const CHANNELS: ConsentChannel[] = ['email', 'sms', 'push'];
type Draft = string | boolean | number[];

/** NFR-16: dates and numbers follow the UI locale; instants use the user's own time zone. */
function useFormats() {
  const locale = useLocale();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    number: (n: number) => new Intl.NumberFormat(locale).format(n),
    // A calendar date has no time zone: format it as UTC so it never shifts a day.
    date: (ymd: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
        new Date(`${ymd}T00:00:00Z`)
      ),
    instant: (iso: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
        new Date(iso)
      ),
  };
}

export function ContactDetail({ id }: { id: string }) {
  const t = useTranslations('contacts-detail');
  const locale = useLocale() as Locale;
  const fmt = useFormats();
  const [fields, setFields] = useState<Field[]>([]);
  const [profile, setProfile] = useState<ContactProfile | null>(null);
  const [history, setHistory] = useState<Consent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; draft: Draft } | null>(null);
  const [consent, setConsent] = useState({ channel: 'email', value: '1', text: '' });

  const load = useCallback(async () => {
    const [f, p, h] = await Promise.all([
      api<{ items: Field[] }>('GET', '/fields'),
      api<ContactProfile>('GET', `/contacts/${id}`),
      api<Page<Consent>>('GET', `/contacts/${id}/consents`, { query: { limit: 50 } }),
    ]);
    if (!f.data || !p.data || !h.data) return setError(t('errors.load'));
    setFields(f.data.items);
    setProfile(p.data);
    setHistory(h.data.items);
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  function show(field: Field, v: FieldValue | undefined): string {
    if (v === undefined || v === null || v === '') return t('profile.empty');
    const choice = (cid: number) => field.choices.find((c) => c.id === cid)?.labels[locale] ?? '';
    switch (field.type) {
      case 'number':
        return fmt.number(Number(v));
      case 'date':
        return fmt.date(String(v));
      case 'boolean':
        return t(v ? 'profile.yes' : 'profile.no');
      case 'single_choice':
        return choice(Number(v));
      case 'multi_choice':
        return (v as number[]).map(choice).join(', ');
      default:
        return String(v);
    }
  }

  function startEdit(field: Field) {
    const v = profile?.fields[String(field.field_id)];
    const draft: Draft =
      field.type === 'boolean'
        ? v === true
        : field.type === 'multi_choice'
          ? ((v as number[] | undefined) ?? [])
          : String(v ?? '');
    setEditing({ id: field.field_id, draft });
  }

  async function save(e: FormEvent, field: Field) {
    e.preventDefault();
    const d = editing!.draft;
    let value: FieldValue;
    if (field.type === 'boolean') value = d as boolean;
    else if (field.type === 'multi_choice') value = (d as number[]).length ? (d as number[]) : null;
    else if (d === '') value = null;
    else value = field.type === 'number' || field.type === 'single_choice' ? Number(d) : String(d);
    const res = await api('PATCH', `/contacts/${id}`, {
      body: { fields: { [field.field_id]: value } },
    });
    if (!res.ok) return setError(t(res.status === 409 ? 'errors.duplicate' : 'errors.generic'));
    setError(null);
    setEditing(null);
    await load();
  }

  async function recordConsent(e: FormEvent) {
    e.preventDefault();
    const res = await api('POST', `/contacts/${id}/consents`, {
      body: {
        channel: consent.channel,
        value: Number(consent.value),
        source: 'admin',
        text: consent.text.trim(),
      },
    });
    if (!res.ok) return setError(t('errors.generic'));
    setError(null);
    setConsent({ ...consent, text: '' });
    await load();
  }

  function editor(field: Field) {
    const d = editing!.draft;
    const set = (v: Draft) => setEditing({ id: field.field_id, draft: v });
    const labelId = `f-${field.field_id}`;
    const cls = 'h-9 rounded-md border px-3 text-sm';
    switch (field.type) {
      case 'boolean':
        return (
          <input
            id={labelId}
            type="checkbox"
            checked={d as boolean}
            onChange={(e) => set(e.target.checked)}
          />
        );
      case 'single_choice':
        return (
          <select id={labelId} value={d as string} onChange={(e) => set(e.target.value)} className={cls}>
            <option value="">{t('profile.empty')}</option>
            {field.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.labels[locale]}
              </option>
            ))}
          </select>
        );
      case 'multi_choice':
        return (
          <span id={labelId} className="flex gap-3">
            {field.choices.map((c) => (
              <label key={c.id} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={(d as number[]).includes(c.id)}
                  onChange={(e) =>
                    set(
                      e.target.checked
                        ? [...(d as number[]), c.id]
                        : (d as number[]).filter((x) => x !== c.id)
                    )
                  }
                />
                {c.labels[locale]}
              </label>
            ))}
          </span>
        );
      default:
        return (
          <input
            id={labelId}
            type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
            step={field.type === 'number' ? 'any' : undefined}
            value={d as string}
            onChange={(e) => set(e.target.value)}
            className={cls}
          />
        );
    }
  }

  if (!profile) {
    return error ? (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    ) : (
      <p>{t('loading')}</p>
    );
  }

  const visible = fields.filter((f) => !CONSENT_FIELD_IDS.includes(f.field_id));
  const groups = [
    { key: 'system', items: visible.filter((f) => f.is_system) },
    { key: 'custom', items: visible.filter((f) => !f.is_system) },
  ];
  const title =
    [profile.fields['1'], profile.fields['2']].filter(Boolean).join(' ') ||
    String(profile.fields['3'] ?? id);
  const consentLabel = (v: number | null) =>
    t(v === 1 ? 'consent.yes' : v === 2 ? 'consent.no' : 'consent.unknown');

  return (
    <div className="space-y-8">
      <Link href="/contacts" className="text-sm underline">
        {t('detail.back')}
      </Link>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {groups.map(
        (g) =>
          g.items.length > 0 && (
            <section key={g.key} aria-labelledby={`g-${g.key}`} className="space-y-2">
              <h2 id={`g-${g.key}`} className="font-semibold">
                {t(`profile.${g.key}`)}
              </h2>
              <dl className="space-y-2">
                {g.items.map((f) => {
                  const isEditing = editing?.id === f.field_id;
                  return (
                    <div key={f.field_id} className="flex flex-wrap items-center gap-3">
                      <dt className="w-48 text-sm font-medium">
                        {isEditing && f.type !== 'multi_choice' && f.type !== 'boolean' ? (
                          <label htmlFor={`f-${f.field_id}`}>{f.labels[locale]}</label>
                        ) : (
                          f.labels[locale]
                        )}
                      </dt>
                      <dd className="flex items-center gap-2">
                        {isEditing ? (
                          <form onSubmit={(e) => save(e, f)} className="flex items-center gap-2">
                            {editor(f)}
                            <Button type="submit" size="sm">
                              {t('profile.save')}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                              {t('profile.cancel')}
                            </Button>
                          </form>
                        ) : (
                          <>
                            <span>{show(f, profile.fields[String(f.field_id)])}</span>
                            {!f.read_only && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => startEdit(f)}
                                aria-label={t('profile.edit', { name: f.labels[locale] })}
                              >
                                {t('profile.editShort')}
                              </Button>
                            )}
                          </>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {g.key === 'system' && (
                <p className="text-xs">
                  {t('profile.updated', { date: fmt.instant(profile.updated_at) })}
                </p>
              )}
            </section>
          )
      )}

      <section aria-labelledby="consents-title" className="space-y-3">
        <h2 id="consents-title" className="font-semibold">
          {t('consent.title')}
        </h2>
        <ul className="flex gap-6">
          {CHANNELS.map((ch) => (
            <li key={ch}>
              {t(`consent.channels.${ch}`)}: <strong>{consentLabel(profile.consents[ch])}</strong>
            </li>
          ))}
        </ul>

        <form onSubmit={recordConsent} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="consent-channel" className="text-sm font-medium">
              {t('consent.channel')}
            </label>
            <select
              id="consent-channel"
              value={consent.channel}
              onChange={(e) => setConsent({ ...consent, channel: e.target.value })}
              className="h-9 rounded-md border px-3 text-sm"
            >
              {CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {t(`consent.channels.${ch}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="consent-value" className="text-sm font-medium">
              {t('consent.value')}
            </label>
            <select
              id="consent-value"
              value={consent.value}
              onChange={(e) => setConsent({ ...consent, value: e.target.value })}
              className="h-9 rounded-md border px-3 text-sm"
            >
              <option value="1">{t('consent.yes')}</option>
              <option value="2">{t('consent.no')}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="consent-text" className="text-sm font-medium">
              {t('consent.text')}
            </label>
            <textarea
              id="consent-text"
              required
              maxLength={5000}
              value={consent.text}
              onChange={(e) => setConsent({ ...consent, text: e.target.value })}
              className="rounded-md border px-3 py-1 text-sm"
            />
          </div>
          <Button type="submit">{t('consent.submit')}</Button>
        </form>

        <h3 className="text-sm font-semibold">{t('consent.history')}</h3>
        {history.length === 0 ? (
          <p>{t('consent.noHistory')}</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">{t('consent.history')}</caption>
            <thead>
              <tr className="text-left">
                <th scope="col">{t('consent.channel')}</th>
                <th scope="col">{t('consent.value')}</th>
                <th scope="col">{t('consent.date')}</th>
                <th scope="col">{t('consent.source')}</th>
                <th scope="col">{t('consent.text')}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((c) => (
                <tr key={c.id} className="border-t">
                  <td>{t(`consent.channels.${c.channel}`)}</td>
                  <td>{consentLabel(c.value)}</td>
                  <td>{fmt.instant(c.changed_at)}</td>
                  <td>{c.source}</td>
                  <td>{c.text ?? t('profile.empty')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="lists-title" className="space-y-2">
        <h2 id="lists-title" className="font-semibold">
          {t('lists.title')}
        </h2>
        {profile.lists.length === 0 ? (
          <p>{t('lists.empty')}</p>
        ) : (
          <ul className="list-disc pl-5">
            {profile.lists.map((l) => (
              <li key={l.id}>
                <Link href={`/contacts/lists/${l.id}`} className="underline">
                  {l.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        Extension point for F2.7 (contact timeline). Contract: this element stays empty here;
        F2.7 renders its timeline inside it (portal or by editing this file). Keep the
        `data-slot="timeline"` attribute so the slot stays discoverable.
      */}
      <section aria-label={t('timeline.label')}>
        <div data-slot="timeline" />
      </section>
    </div>
  );
}
