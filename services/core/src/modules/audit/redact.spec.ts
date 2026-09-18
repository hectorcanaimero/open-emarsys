import { redactDiff } from './redact.js';

describe('redactDiff', () => {
  it('redacts password, secret, token and mfa_* keys', () => {
    expect(
      redactDiff({
        email: 'ana@a.test',
        password: 'hunter2',
        client_secret: 'shh',
        refresh_token: 'rt-1',
        mfa_recovery_code: 'abc',
      })
    ).toEqual({
      email: 'ana@a.test',
      password: '[REDACTED]',
      client_secret: '[REDACTED]',
      refresh_token: '[REDACTED]',
      mfa_recovery_code: '[REDACTED]',
    });
  });

  it('redacts nested objects and arrays', () => {
    expect(redactDiff({ user: { password: 'x' }, tokens: [{ token: 'a' }] })).toEqual({
      user: { password: '[REDACTED]' },
      tokens: [{ token: '[REDACTED]' }],
    });
  });

  it('passes through null and non-sensitive values unchanged', () => {
    expect(redactDiff(null)).toBeNull();
    expect(redactDiff({ name: 'ana', age: 30 })).toEqual({ name: 'ana', age: 30 });
  });
});
