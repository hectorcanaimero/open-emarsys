import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const LOCALES = ['es', 'pt', 'en'] as const;

/** `Intl` already knows every IANA time zone name; no separate list to maintain. */
function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z
  .string()
  .min(1)
  .refine(isIanaTimeZone, { message: 'must be a valid IANA time zone' });

const limitsSchema = z
  .object({
    max_contacts: z.number().int().min(0).nullable().optional(),
    max_emails_per_month: z.number().int().min(0).nullable().optional(),
    max_users: z.number().int().min(0).nullable().optional(),
    max_api_requests_per_minute: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export type TenantLimits = z.infer<typeof limitsSchema>;

export const tenantCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    timezone: timezoneSchema,
    default_locale: z.enum(LOCALES),
    limits: limitsSchema.optional(),
  })
  .strict();

export type TenantCreateInput = z.infer<typeof tenantCreateSchema>;

export const tenantUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    timezone: timezoneSchema.optional(),
    default_locale: z.enum(LOCALES).optional(),
    limits: limitsSchema.optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one property required' });

export type TenantUpdateInput = z.infer<typeof tenantUpdateSchema>;

/** Parses `body` against `schema`; a mismatch becomes a 400 `problem+json` (C3). */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      errors: result.error.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`,
        detail: issue.message,
      })),
    });
  }
  return result.data;
}
