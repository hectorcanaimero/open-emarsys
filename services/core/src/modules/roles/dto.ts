import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSION_ACTIONS, PERMISSION_MODULES } from '../identity-shared/permissions.js';

export const permissionSchema = z.object({
  module: z.enum(PERMISSION_MODULES),
  action: z.enum(PERMISSION_ACTIONS),
});

export const roleInputSchema = z.object({
  name: z.string().min(1).max(100),
  permissions: z.array(permissionSchema),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

export const roleUpdateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    permissions: z.array(permissionSchema).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one property is required' });
export type RoleUpdateInput = z.infer<typeof roleUpdateSchema>;

/** Parses `body` against `schema`, or throws a `Problem`-shaped 400 (C3 `errors[]`). */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      errors: result.error.issues.map((issue) => ({
        pointer: issue.path.join('/'),
        detail: issue.message,
      })),
    });
  }
  return result.data;
}
