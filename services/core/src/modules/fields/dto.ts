import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const apiName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const labels = z.object({ es: z.string().min(1), pt: z.string().min(1), en: z.string().min(1) });
const type = z.enum(['text', 'number', 'date', 'boolean', 'single_choice', 'multi_choice']);
const choiceInput = z.object({ id: z.number().int().min(1).optional(), api_name: apiName, labels });

export const fieldCreateSchema = z
  .object({ api_name: apiName, type, labels, choices: z.array(choiceInput).default([]), unique: z.boolean().default(false) })
  .refine((v) => !v.type.endsWith('_choice') || v.choices.length > 0, { message: 'choices are required for choice fields', path: ['choices'] });
export type FieldCreate = z.infer<typeof fieldCreateSchema>;

export const fieldUpdateSchema = z
  .object({ api_name: apiName, labels, choices: z.array(choiceInput) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one property is required' });
export type FieldUpdate = z.infer<typeof fieldUpdateSchema>;

/** Public v3 `FieldCreate`: one `name` for every locale, choices as plain strings. */
export const publicFieldCreateSchema = z.object({
  name: z.string().min(1).max(100),
  application_type: type,
  string_id: apiName.optional(),
  unique: z.boolean().default(false),
  choices: z.array(z.string().min(1)).default([]),
});

export function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({ errors: result.error.issues.map((i) => ({ pointer: i.path.join('/'), detail: i.message })) });
  }
  return result.data;
}

/** snake_case from free text: `Fecha de Compra` → `fecha_de_compra`. */
export function snakeCase(text: string): string {
  const s = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (/^[a-z]/.test(s) ? s : `f_${s}`).slice(0, 63);
}
