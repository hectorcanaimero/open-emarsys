'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useActionState, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import type { ActionState, EnrollState } from './actions';

type FormActionFn = (prev: ActionState, form: FormData) => Promise<ActionState>;

export interface SecurityActions {
  enrollMfa: () => Promise<EnrollState>;
  confirmMfa: FormActionFn;
  disableMfa: FormActionFn;
  updateLocale: FormActionFn;
}

const ERROR_KEYS = {
  invalidCode: 'errors.invalidCode',
  mfaAlreadyEnabled: 'security.mfaAlreadyEnabled',
  mfaNotEnabled: 'security.mfaNotEnabled',
  unknown: 'errors.unknown',
} as const;

const inputClass =
  'h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function CodeInput({ id }: { id: string }) {
  return (
    <input
      id={id}
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      required
      className={inputClass}
    />
  );
}

export function SecurityPanel({ actions }: { actions: SecurityActions }) {
  const t = useTranslations('auth');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  const [enroll, setEnroll] = useState<EnrollState>({ status: 'idle' });
  const [enrolling, startEnroll] = useTransition();
  const [confirmed, confirmAction, confirming] = useActionState(actions.confirmMfa, { status: 'idle' });
  const [disabled, disableAction, disabling] = useActionState(actions.disableMfa, { status: 'idle' });
  const [saved, localeAction, saving] = useActionState<ActionState, FormData>(async (prev, form) => {
    const state = await actions.updateLocale(prev, form);
    if (state.status === 'ok') router.replace(pathname, { locale: String(form.get('locale')) });
    return state;
  }, { status: 'idle' });

  const feedback = (state: ActionState | EnrollState, ok: string) => {
    if (state.status === 'ok') return <p role="status">{ok}</p>;
    if (state.status === 'error') {
      return (
        <p role="alert" className="text-sm text-red-700">
          {t(ERROR_KEYS[state.error])}
        </p>
      );
    }
    return null;
  };

  return (
    <div className="space-y-8">
      <section aria-labelledby="mfa-heading" className="space-y-4">
        <h2 id="mfa-heading" className="text-lg font-semibold">
          {t('security.mfaHeading')}
        </h2>
        {confirmed.status === 'ok' ? (
          feedback(confirmed, t('security.mfaEnabled'))
        ) : enroll.status === 'pending' ? (
          <form action={confirmAction} className="space-y-3">
            <p>{t('security.mfaScan')}</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, nothing to optimize */}
            <img src={enroll.qr} alt={t('security.mfaQrAlt')} width={200} height={200} />
            <p className="text-sm">
              {t('security.mfaSecret', { secret: enroll.secret })}
            </p>
            {feedback(confirmed, '')}
            <label htmlFor="confirm-code" className="block text-sm font-medium">
              {t('code')}
            </label>
            <CodeInput id="confirm-code" />
            <Button type="submit" disabled={confirming}>
              {t('security.mfaConfirm')}
            </Button>
          </form>
        ) : (
          <>
            {feedback(enroll, '')}
            <Button
              type="button"
              disabled={enrolling}
              onClick={() => startEnroll(async () => setEnroll(await actions.enrollMfa()))}
            >
              {t('security.mfaEnable')}
            </Button>
          </>
        )}
      </section>

      <section aria-labelledby="mfa-disable-heading" className="space-y-4">
        <h2 id="mfa-disable-heading" className="text-lg font-semibold">
          {t('security.mfaDisableHeading')}
        </h2>
        <form action={disableAction} className="space-y-3">
          {feedback(disabled, t('security.mfaDisabled'))}
          <label htmlFor="disable-code" className="block text-sm font-medium">
            {t('code')}
          </label>
          <CodeInput id="disable-code" />
          <Button type="submit" disabled={disabling}>
            {t('security.mfaDisable')}
          </Button>
        </form>
      </section>

      <section aria-labelledby="language-heading" className="space-y-4">
        <h2 id="language-heading" className="text-lg font-semibold">
          {t('security.languageHeading')}
        </h2>
        <form action={localeAction} className="space-y-3">
          {feedback(saved, '')}
          <label htmlFor="locale" className="block text-sm font-medium">
            {t('security.language')}
          </label>
          <select id="locale" name="locale" defaultValue={locale} className={inputClass}>
            {routing.locales.map((loc) => (
              <option key={loc} value={loc}>
                {new Intl.DisplayNames([loc], { type: 'language' }).of(loc)}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={saving}>
            {t('security.languageSave')}
          </Button>
        </form>
      </section>
    </div>
  );
}
