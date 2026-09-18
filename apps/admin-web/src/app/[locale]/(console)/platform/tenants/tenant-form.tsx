'use client';

import { useId } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { tenantFormSchema, type Tenant, type TenantFormValues } from './schema';

const TIME_ZONES = Intl.supportedValuesOf('timeZone');
const LOCALES = ['es', 'pt', 'en'] as const;

function toFieldString(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function toDefaultValues(tenant?: Tenant): TenantFormValues {
  return {
    name: tenant?.name ?? '',
    timezone: tenant?.timezone ?? '',
    default_locale: tenant?.default_locale ?? 'es',
    limits: {
      max_contacts: toFieldString(tenant?.limits.max_contacts),
      max_emails_per_month: toFieldString(tenant?.limits.max_emails_per_month),
      max_users: toFieldString(tenant?.limits.max_users),
      max_api_requests_per_minute: toFieldString(tenant?.limits.max_api_requests_per_minute),
    },
  };
}

const LIMIT_FIELDS = [
  { key: 'max_contacts', name: 'limits.max_contacts', labelKey: 'fields.maxContacts' },
  {
    key: 'max_emails_per_month',
    name: 'limits.max_emails_per_month',
    labelKey: 'fields.maxEmailsPerMonth',
  },
  { key: 'max_users', name: 'limits.max_users', labelKey: 'fields.maxUsers' },
  {
    key: 'max_api_requests_per_minute',
    name: 'limits.max_api_requests_per_minute',
    labelKey: 'fields.maxApiRequestsPerMinute',
  },
] as const;

function FieldError({ message }: { message?: string }) {
  const t = useTranslations('platform');
  if (!message) return null;
  return (
    <p className="mt-1 text-sm text-red-600" role="alert">
      {t(message)}
    </p>
  );
}

export function TenantForm({
  tenant,
  submitting,
  onSubmit,
  onCancel,
}: {
  tenant?: Tenant;
  submitting: boolean;
  onSubmit: (values: TenantFormValues) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('platform');
  const formId = useId();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<TenantFormValues>({
    resolver: zodResolver(tenantFormSchema),
    defaultValues: toDefaultValues(tenant),
  });

  const limitErrors = errors.limits ?? {};

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="space-y-4">
        <div>
          <label htmlFor={`${formId}-name`} className="block text-sm font-medium">
            {t('fields.name')}
          </label>
          <input
            id={`${formId}-name`}
            className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
            {...register('name')}
          />
          <FieldError message={errors.name?.message} />
        </div>

        <div>
          <label htmlFor={`${formId}-timezone`} className="block text-sm font-medium">
            {t('fields.timezone')}
          </label>
          <input
            id={`${formId}-timezone`}
            list={`${formId}-timezones`}
            autoComplete="off"
            className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
            {...register('timezone')}
          />
          <datalist id={`${formId}-timezones`}>
            {TIME_ZONES.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <FieldError message={errors.timezone?.message} />
        </div>

        <div>
          <label htmlFor={`${formId}-locale`} className="block text-sm font-medium">
            {t('fields.defaultLocale')}
          </label>
          <select
            id={`${formId}-locale`}
            className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
            {...register('default_locale')}
          >
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {t(`locales.${locale}`)}
              </option>
            ))}
          </select>
          <FieldError message={errors.default_locale?.message} />
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t('fields.limits')}</legend>
          {LIMIT_FIELDS.map(({ key, name, labelKey }) => {
            const fieldId = `${formId}-${name}`;
            return (
              <div key={name}>
                <label htmlFor={fieldId} className="block text-sm">
                  {t(labelKey)}
                </label>
                <input
                  id={fieldId}
                  type="number"
                  min={0}
                  placeholder={t('fields.unlimitedPlaceholder')}
                  className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
                  {...register(name)}
                />
                <FieldError message={limitErrors[key]?.message} />
              </div>
            );
          })}
        </fieldset>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('actions.cancel')}
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? t('actions.saving') : t('actions.save')}
        </Button>
      </div>
    </form>
  );
}
