import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SystemStatus } from '@/components/system-status';
import { PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** System health page (T-P2-55). */
export default async function SystemPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('system');
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <SystemStatus />
    </div>
  );
}
