import type { components } from '@oe/ts-contracts/openapi/identity';

type Problem = components['schemas']['Problem'];

/**
 * The contract's `Problem.type` is always `about:blank` (see
 * `packages/ts-common/src/http/problem-json.filter.ts`), so it carries no
 * machine-readable code. The only documented failure reasons for these
 * operations are the ones named below, so the HTTP status plus the
 * operation is enough to pick a localized message instead of showing the
 * backend's (untranslated) `detail` text.
 */
export type UserErrorKey = 'duplicateEmail' | 'lastAdmin' | 'generic';

export function classifyUserError(
  op: 'invite' | 'delete' | 'updateStatus' | 'updateRoles',
  status: number
): UserErrorKey {
  if (status === 409 && op === 'invite') return 'duplicateEmail';
  if (status === 409 && (op === 'delete' || op === 'updateStatus')) return 'lastAdmin';
  return 'generic';
}

export function readProblemDetail(error: unknown): string | undefined {
  const problem = error as Problem | undefined;
  return problem?.detail;
}
