import { z } from 'zod';
import type { components } from '@oe/ts-contracts/openapi/identity';

export type Tenant = components['schemas']['Tenant'];
export type TenantCreateDto = components['schemas']['TenantCreate'];
export type TenantUpdateDto = components['schemas']['TenantUpdate'];

const IANA_TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

const LOCALES = ['es', 'pt', 'en'] as const;

// Limits are edited as text inputs (blank = unlimited); kept as validated strings here and
// converted to numbers only when building the API payload, so the form never fights the
// number-or-null shape the contract expects.
const limitField = z
  .string()
  .trim()
  .refine((value) => value === '' || /^\d+$/.test(value), { message: 'errors.limitInvalid' });

export const tenantFormSchema = z.object({
  name: z.string().min(1, 'errors.nameRequired').max(200, 'errors.nameTooLong'),
  timezone: z
    .string()
    .min(1, 'errors.timezoneRequired')
    .refine((tz) => IANA_TIME_ZONES.has(tz), { message: 'errors.timezoneInvalid' }),
  default_locale: z.enum(LOCALES, { message: 'errors.localeRequired' }),
  limits: z.object({
    max_contacts: limitField,
    max_emails_per_month: limitField,
    max_users: limitField,
    max_api_requests_per_minute: limitField,
  }),
});

export type TenantFormValues = z.infer<typeof tenantFormSchema>;

function toNullableInt(value: string): number | null {
  return value === '' ? null : Number(value);
}

// Return type is pinned to the generated contract DTO, so a schema/contract drift is a
// compile error here instead of a silent bad request at runtime.
export function toTenantPayload(values: TenantFormValues): TenantCreateDto & TenantUpdateDto {
  return {
    name: values.name,
    timezone: values.timezone,
    default_locale: values.default_locale,
    limits: {
      max_contacts: toNullableInt(values.limits.max_contacts),
      max_emails_per_month: toNullableInt(values.limits.max_emails_per_month),
      max_users: toNullableInt(values.limits.max_users),
      max_api_requests_per_minute: toNullableInt(values.limits.max_api_requests_per_minute),
    },
  };
}
