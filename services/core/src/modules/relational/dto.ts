import { z } from 'zod';
import { parseBody } from '../fields/dto.js';

export { parseBody };

const apiName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const type = z.enum(['text', 'number', 'date', 'boolean', 'single_choice', 'multi_choice']);
/** Choice columns list the option IDs they accept. */
const column = z.object({ name: apiName, type, choices: z.array(z.object({ id: z.number().int().min(1) })).optional() });
export type ColumnInput = z.infer<typeof column>;

const uniqueNames = (cols: ColumnInput[]): boolean => new Set(cols.map((c) => c.name)).size === cols.length;

export const tableCreateSchema = z
  .object({ name: apiName, key_field: z.string(), columns: z.array(column).min(1).max(100) })
  .refine((v) => uniqueNames(v.columns), { message: 'column names must be unique', path: ['columns'] })
  .refine((v) => v.columns.some((c) => c.name === v.key_field), { message: 'key_field must be one of the columns', path: ['key_field'] });

export const tableUpdateSchema = z
  .object({ name: apiName, add_columns: z.array(column).min(1) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one property is required' });

const rowsSchema = z.array(z.object({ key_value: z.string(), row_key: z.string().min(1), data: z.record(z.unknown()) })).min(1);

/** Public v3 body; more than 1,000 rows is 1002, checked by the controller. */
export const rowsRequestSchema = z.object({ key_id: z.union([z.string(), z.number()]).transform(String), rows: rowsSchema });
export const internalRowsRequestSchema = rowsRequestSchema.extend({ tenant_id: z.string().uuid() });
