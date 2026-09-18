export const ACCESS_COOKIE = 'oe_at';
export const REFRESH_COOKIE = 'oe_rt';
export const MFA_COOKIE = 'oe_mfa';
/** Double-submit token: readable by JS on purpose, it proves same-origin, not identity. */
export const CSRF_COOKIE = 'oe_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** The refresh token only travels to the handlers that consume it. */
export const REFRESH_PATH = '/api/auth';
export const MFA_PATH = '/api/auth/mfa';

/** Body of every `/api/auth/*` JSON response the forms read. */
export type AuthResult =
  | { next: string }
  | { mfa: true }
  | { error: 'invalid' | 'locked' | 'rate_limited' | 'expired' | 'csrf' | 'unknown'; retryAfter?: number };
