import { LOCALES } from '@qos/ui';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import type { ReactNode } from 'react';

const LOCALE_NAME: Record<string, string> = { en: 'English', ar: 'العربية' };

/** Pages for people who are not signed in: sign-in, first-run setup, invitations, password reset. */
export default async function PublicLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('app');
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
      <div className="flex w-full max-w-md items-center justify-between">
        <span className="text-lg font-semibold">{t('name')}</span>
        <nav aria-label={t('language')} className="flex gap-1 text-sm">
          {LOCALES.map((l) => (
            <Link
              key={l}
              href={`/${l}/login`}
              lang={l}
              className={l === locale ? 'font-medium text-accent' : 'text-muted'}
            >
              {LOCALE_NAME[l]}
            </Link>
          ))}
        </nav>
      </div>
      <main id="main" className="w-full max-w-md rounded-lg border border-line bg-surface p-6">
        {children}
      </main>
    </div>
  );
}
