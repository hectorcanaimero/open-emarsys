'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { LOCALES, type Field, type FieldChoice, type FieldType, type Labels } from './api';

const TYPES: FieldType[] = ['text', 'number', 'date', 'boolean', 'single_choice', 'multi_choice'];
const emptyLabels = (): Labels => ({ es: '', pt: '', en: '' });
const input = 'h-9 rounded-md border px-3 text-sm';

export interface FieldDraft {
  api_name: string;
  type: FieldType;
  unique: boolean;
  labels: Labels;
  choices: FieldChoice[];
}

/** Creates a custom field (`field` undefined) or edits one; only labels/options change on edit. */
export function FieldForm({
  field,
  error,
  onSubmit,
  onCancel,
}: {
  field?: Field;
  error: string | null;
  onSubmit: (draft: FieldDraft) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('contacts-fields');
  const [draft, setDraft] = useState<FieldDraft>({
    api_name: field?.api_name ?? '',
    type: field?.type ?? 'text',
    unique: field?.unique ?? false,
    labels: field?.labels ?? emptyLabels(),
    choices: field?.choices ?? [],
  });
  const isChoice = draft.type === 'single_choice' || draft.type === 'multi_choice';
  const set = (patch: Partial<FieldDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setChoice = (i: number, patch: Partial<FieldChoice>) =>
    set({ choices: draft.choices.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ ...draft, choices: isChoice ? draft.choices : [] });
  }

  return (
    <form onSubmit={submit} aria-labelledby="field-form-title" className="space-y-4 rounded-md border p-4">
      <h2 id="field-form-title" className="font-semibold">
        {field ? t('form.editTitle', { name: field.api_name }) : t('form.createTitle')}
      </h2>
      {field && <p className="text-sm text-muted-foreground">{t('form.fixedNote')}</p>}

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="ff-api-name" className="text-sm font-medium">
            {t('form.apiName')}
          </label>
          <input
            id="ff-api-name"
            required
            pattern="[a-z][a-z0-9_]{0,62}"
            disabled={field?.is_system}
            value={draft.api_name}
            onChange={(e) => set({ api_name: e.target.value })}
            className={input}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="ff-type" className="text-sm font-medium">
            {t('form.type')}
          </label>
          <select
            id="ff-type"
            disabled={!!field}
            value={draft.type}
            onChange={(e) => set({ type: e.target.value as FieldType })}
            className={input}
          >
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`types.${type}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2 pb-2">
          <input
            id="ff-unique"
            type="checkbox"
            disabled={!!field}
            checked={draft.unique}
            onChange={(e) => set({ unique: e.target.checked })}
          />
          <label htmlFor="ff-unique" className="text-sm font-medium">
            {t('form.unique')}
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        {LOCALES.map((locale) => (
          <div key={locale} className="flex flex-col gap-1">
            <label htmlFor={`ff-label-${locale}`} className="text-sm font-medium">
              {t('form.label', { locale })}
            </label>
            <input
              id={`ff-label-${locale}`}
              required
              value={draft.labels[locale]}
              onChange={(e) => set({ labels: { ...draft.labels, [locale]: e.target.value } })}
              className={input}
            />
          </div>
        ))}
      </div>

      {isChoice && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t('form.options')}</legend>
          {draft.choices.map((choice, i) => {
            const n = i + 1;
            return (
              <div key={choice.id ?? `new-${i}`} className="flex flex-wrap items-end gap-2">
                <span className="w-20 pb-2 font-mono text-xs">
                  {choice.id ? t('form.optionId', { id: choice.id }) : t('form.optionNew')}
                </span>
                <input
                  aria-label={t('form.optionApiName', { n })}
                  required
                  pattern="[a-z][a-z0-9_]{0,62}"
                  value={choice.api_name}
                  onChange={(e) => setChoice(i, { api_name: e.target.value })}
                  className={input}
                />
                {LOCALES.map((locale) => (
                  <input
                    key={locale}
                    aria-label={t('form.optionLabel', { n, locale })}
                    required
                    value={choice.labels[locale]}
                    onChange={(e) => setChoice(i, { labels: { ...choice.labels, [locale]: e.target.value } })}
                    className={input}
                  />
                ))}
                {!choice.id && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => set({ choices: draft.choices.filter((_, j) => j !== i) })}
                  >
                    {t('form.removeOption', { n })}
                  </Button>
                )}
              </div>
            );
          })}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              set({ choices: [...draft.choices, { api_name: '', labels: emptyLabels() }] })
            }
          >
            {t('form.addOption')}
          </Button>
        </fieldset>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={isChoice && draft.choices.length === 0}>
          {t('save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}
