import type { ProjectResponse } from '@qos/contracts';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { DemoSeedButton } from '@/components/demo-seed';
import { SystemStatus } from '@/components/system-status';
import { Badge, EmptyState, PageHeader } from '@/components/ui';
import { getSession, serverGet } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/** Home: the caller's projects, the demo-data offer in demo mode, and system status. */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('home');
  const o = await getTranslations('overview');
  const session = await getSession();
  const signedIn = session.state === 'signed_in';
  const projects = signedIn ? ((await serverGet<ProjectResponse[]>('/projects')).data ?? []) : [];
  const demo = signedIn ? (await serverGet<{ enabled: boolean; seeded: boolean }>('/demo')).data : null;
  const canCreate = signedIn && session.permissions.includes('project.create');

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title={o('title')}
        subtitle={signedIn ? t('welcome', { name: session.me.displayName }) : o('subtitle')}
        actions={
          canCreate ? (
            <Link
              href={`/${locale}/projects/new`}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-contrast"
              data-testid="new-project"
            >
              {t('newProject')}
            </Link>
          ) : null
        }
      />
      {signedIn ? (
        <section aria-labelledby="projects-heading" className="flex flex-col gap-3">
          <h2 id="projects-heading" className="text-sm font-medium text-muted">
            {t('projects')}
          </h2>
          {demo?.enabled && !demo.seeded && canCreate ? <DemoSeedButton /> : null}
          {projects.length === 0 ? (
            <EmptyState title={t('noProjects')}>
              {canCreate ? t('noProjectsHint') : t('noProjectsMember')}
            </EmptyState>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-list">
              {projects.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/${locale}/projects/${p.key}`}
                    className="flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-4 hover:border-accent"
                    data-project={p.key}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">{p.name}</span>
                      <bdi dir="ltr" className="font-mono text-xs text-muted">
                        {p.key}
                      </bdi>
                    </span>
                    <span className="line-clamp-2 text-sm text-muted">{p.description || '—'}</span>
                    <span className="mt-auto flex gap-2">
                      {p.isDemo ? <Badge tone="accent">{t('demo')}</Badge> : null}
                      {p.status !== 'active' ? <Badge tone="warning">{t(`status_${p.status}`)}</Badge> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <SystemStatus />
    </div>
  );
}
