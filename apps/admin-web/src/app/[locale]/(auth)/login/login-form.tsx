'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { errorMessage, postAuth } from '@/lib/session/client';

export const inputClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function LoginForm({ next }: { next: string }) {
  const t = useTranslations('auth');
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await postAuth('/api/auth/login', {
      email: form.get('email'),
      password: form.get('password'),
      next,
      locale,
    });
    if ('next' in result) return window.location.assign(result.next);
    if ('mfa' in result) {
      return window.location.assign(`/${locale}/mfa?next=${encodeURIComponent(next)}`);
    }
    setError(errorMessage(t, result));
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="space-y-1">
        <label htmlFor="email" className="text-sm font-medium">
          {t('email')}
        </label>
        <input id="email" name="email" type="email" autoComplete="username" required className={inputClass} />
      </div>
      <div className="space-y-1">
        <label htmlFor="password" className="text-sm font-medium">
          {t('password')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {t('login.submit')}
      </Button>
    </form>
  );
}
