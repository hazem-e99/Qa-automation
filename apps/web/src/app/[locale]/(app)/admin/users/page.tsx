import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui';
import { getSession } from '@/lib/server-api';
import { UsersAdmin } from './users-admin';

export const dynamic = 'force-dynamic';

export default async function UsersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('admin');
  const session = await getSession();
  const allowed = session.state === 'signed_in' && session.permissions.includes('user.manage');
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {allowed ? <UsersAdmin /> : <Notice tone="warning">{t('notAllowed')}</Notice>}
    </div>
  );
}
