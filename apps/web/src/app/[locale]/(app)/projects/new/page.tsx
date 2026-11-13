import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui';
import { getSession, serverGet } from '@/lib/server-api';
import { ProjectWizard } from './wizard';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('wizard');
  const session = await getSession();
  const allowed = session.state === 'signed_in' && session.permissions.includes('project.create');
  const demo = allowed ? (await serverGet<{ enabled: boolean }>('/demo')).data : null;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {allowed ? (
        <ProjectWizard demoMode={demo?.enabled === true} />
      ) : (
        <Notice tone="warning">{t('notAllowed')}</Notice>
      )}
    </div>
  );
}
