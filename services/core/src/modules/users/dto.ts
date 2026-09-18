import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const uuid = z.string().uuid();

export const inviteUserSchema = z.object({
  email: z.string().email(),
  role_ids: z.array(uuid).min(1),
  locale: z.enum(['es', 'pt', 'en']).optional(),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const acceptInvitationSchema = z.object({
  name: z.string().min(1).max(200),
  password: z.string().min(12).max(128),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const updateUserSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    role_ids: z.array(uuid).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one property is required' });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

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
