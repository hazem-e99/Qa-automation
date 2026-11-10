import { directionOf, isTheme } from '@qos/ui';
import type { Metadata } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { routing } from '@/i18n/routing';
import '../globals.css';

export const metadata: Metadata = { title: 'QualityOS' };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('app');
  const stored = (await cookies()).get('qos-theme')?.value;
  const theme = isTheme(stored) ? stored : 'system';

  return (
    <html lang={locale} dir={directionOf(locale)} {...(theme === 'system' ? {} : { 'data-theme': theme })}>
      <body>
        <NextIntlClientProvider>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
          >
            {t('skipToContent')}
          </a>
          <div className="flex h-full">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <Topbar locale={locale} theme={theme} />
              <main id="main" className="min-h-0 flex-1 overflow-auto p-6">
                {children}
              </main>
            </div>
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
