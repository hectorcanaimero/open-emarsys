'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { errorMessage, postAuth } from '@/lib/session/client';
import { inputClass } from '../login/login-form';

export function MfaForm({ next }: { next: string }) {
  const t = useTranslations('auth');
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await postAuth('/api/auth/mfa', { code: form.get('code'), next, locale });
    if ('next' in result) return window.location.assign(result.next);
    if ('error' in result) {
      setExpired(result.error === 'expired');
      setError(errorMessage(t, result, 'errors.invalidCode'));
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}{' '}
          {expired && (
            <Link href={{ pathname: '/login', query: { next } }} className="underline">
              {t('backToLogin')}
            </Link>
          )}
        </p>
      )}
      <div className="space-y-1">
        <label htmlFor="code" className="text-sm font-medium">
          {t('code')}
        </label>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          className={inputClass}
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {t('mfa.submit')}
      </Button>
    </form>
  );
}
