import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

/**
 * Each feature ships its own `messages/<locale>/<feature>.json` (C11). We
 * merge every file in the locale's directory into a single messages object
 * keyed by feature name, so new features never need to touch this file.
 */
function loadMessages(locale: string) {
  const dir = path.join(process.cwd(), 'messages', locale);
  const messages: Record<string, unknown> = {};

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const feature = file.replace(/\.json$/, '');
    messages[feature] = JSON.parse(readFileSync(path.join(dir, file), 'utf-8'));
  }

  return messages;
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: loadMessages(locale),
    timeZone: 'UTC',
    formats: {
      dateTime: {
        short: { day: 'numeric', month: 'short', year: 'numeric' },
        shortWithTime: {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
        },
      },
      number: {
        currency: { style: 'currency', currency: 'USD' },
      },
    },
  };
});
