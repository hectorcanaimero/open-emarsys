import type { z } from 'zod';

/**
 * Parses `env` against `schema`, throwing a single readable error listing
 * every failing field when validation fails.
 */
export function loadConfig<T extends z.ZodTypeAny>(
  schema: T,
  env: NodeJS.ProcessEnv = process.env
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}
