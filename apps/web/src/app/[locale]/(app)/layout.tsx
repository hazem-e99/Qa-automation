import { isTheme } from '@qos/ui';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/components/session';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { getSession } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/**
 * The signed-in application shell. Signed-out visitors go to the sign-in page. When the API
 * cannot be reached, the shell still renders with a banner (and the system status page explains
 * which service is down), instead of bouncing between pages.
 */
export default async function AppLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (session.state === 'signed_out') redirect(`/${locale}/login`);
  const t = await getTranslations('app');
  const stored = (await cookies()).get('qos-theme')?.value;
  const theme = isTheme(stored) ? stored : 'system';
  const info = session.state === 'signed_in' ? { ...session.me, permissions: session.permissions } : null;

  return (
    <SessionProvider value={info}>
      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar locale={locale} theme={theme} />
          <main id="main" className="min-h-0 flex-1 overflow-auto p-6">
            {session.state === 'unreachable' ? (
              <div
                role="alert"
                className="mb-4 rounded-md border border-warning px-3 py-2 text-sm text-warning"
                data-testid="api-unreachable"
              >
                {t('apiUnreachable')}
              </div>
            ) : null}
            {children}
          </main>
        </div>
      </div>
    </SessionProvider>
  );
}
