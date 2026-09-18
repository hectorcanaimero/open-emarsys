'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { inputClass } from '../../login/login-form';
import type { InviteState } from './actions';

export function InviteForm({
  action,
}: {
  action: (prev: InviteState, form: FormData) => Promise<InviteState>;
}) {
  const t = useTranslations('auth');
  const [state, formAction, pending] = useActionState(action, { status: 'idle' });

  if (state.status === 'ok') {
    return (
      <div className="space-y-4">
        <p role="status">{t('invite.success')}</p>
        <Link href="/login" className="underline">
          {t('invite.goToLogin')}
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {state.status === 'error' && (
        <p role="alert" className="text-sm text-red-700">
          {t(state.error === 'invalid' ? 'invite.passwordHint' : `errors.${state.error}`)}
        </p>
      )}
      <div className="space-y-1">
        <label htmlFor="name" className="text-sm font-medium">
          {t('invite.name')}
        </label>
        <input id="name" name="name" autoComplete="name" required maxLength={200} className={inputClass} />
      </div>
      <div className="space-y-1">
        <label htmlFor="password" className="text-sm font-medium">
          {t('password')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          aria-describedby="password-hint"
          className={inputClass}
        />
        <p id="password-hint" className="text-xs">
          {t('invite.passwordHint')}
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          {t('invite.confirmPassword')}
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          className={inputClass}
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {t('invite.submit')}
      </Button>
    </form>
  );
}
