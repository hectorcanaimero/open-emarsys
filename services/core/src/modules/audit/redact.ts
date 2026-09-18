// Matches `password`, `client_secret`, `refresh_token`, etc, but not a plain container
// field like `tokens` that merely holds them.
const SENSITIVE_KEY = /^(password|secret|token)$|^(password|secret|token)_|_(password|secret|token)$/i;
const MFA_KEY = /^mfa_/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || MFA_KEY.test(key);
}

/**
 * Recursively redacts `password`/`secret`/`token`/`mfa_*` keys from a diff before it is
 * persisted or published (FR-6): audit entries never carry credentials.
 */
export function redactDiff(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDiff);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        isSensitiveKey(key) ? '[REDACTED]' : redactDiff(v),
      ])
    );
  }
  return value;
}
