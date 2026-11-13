import type {
  EnvironmentResponse,
  MemberResponse,
  ProjectPermissionsResponse,
  ProjectResponse,
} from '@qos/contracts';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { BindingHealthPanel } from '@/components/binding-health';
import { Card, EmptyState } from '@/components/ui';
import { serverGet } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

type AuditPage = {
  items: {
    id: string;
    action: string;
    actorId: string;
    createdAt: string;
    summary: Record<string, unknown>;
  }[];
};

/** Project overview (T-P2-19, M02-FR-11): summary, health, recent activity, quick actions. */
export default async function ProjectOverview({
  params,
}: {
  params: Promise<{ locale: string; key: string }>;
}) {
  const { locale, key } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('project');
  const k = encodeURIComponent(key);
  const [project, perms, members, envs] = await Promise.all([
    serverGet<ProjectResponse>(`/projects/${k}`),
    serverGet<ProjectPermissionsResponse>(`/projects/${k}/permissions`),
    serverGet<MemberResponse[]>(`/projects/${k}/members`),
    serverGet<EnvironmentResponse[]>(`/projects/${k}/environments`),
  ]);
  const p = project.data!;
  const can = (perm: string) => perms.data?.project.includes(perm) ?? false;
  const activity = can('audit.read')
    ? ((await serverGet<AuditPage>(`/audit?projectKey=${k}&limit=10`)).data?.items ?? [])
    : null;
  const base = `/${locale}/projects/${p.key}`;

  return (
    <div className="grid gap-4 lg:grid-cols-3" data-testid="project-overview">
      <div className="flex flex-col gap-4 lg:col-span-2">
        <Card title={t('summary')}>
          <p className="text-sm">{p.description || t('noDescription')}</p>
          <dl className="mt-4 grid grid-cols-3 gap-3 text-center text-sm">
            <div className="rounded-md border border-line p-3">
              <dt className="text-muted">{t('members')}</dt>
              <dd className="text-xl font-semibold" data-testid="member-count">
                {members.data?.length ?? 0}
              </dd>
            </div>
            <div className="rounded-md border border-line p-3">
              <dt className="text-muted">{t('environments')}</dt>
              <dd className="text-xl font-semibold">{envs.data?.length ?? 0}</dd>
            </div>
            <div className="rounded-md border border-line p-3">
              <dt className="text-muted">{t('created')}</dt>
              <dd className="text-sm font-medium">{new Date(p.createdAt).toLocaleDateString(locale)}</dd>
            </div>
          </dl>
        </Card>
        <BindingHealthPanel projectKey={p.key} />
        {activity ? (
          <Card title={t('recentActivity')} testId="recent-activity">
            {activity.length === 0 ? (
              <EmptyState title={t('noActivity')} />
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {activity.map((a) => (
                  <li
                    key={a.id}
                    className="flex justify-between gap-3 border-b border-line pb-2 last:border-0"
                  >
                    <bdi dir="ltr" className="font-mono text-xs">
                      {a.action}
                    </bdi>
                    <span className="text-xs text-muted">{new Date(a.createdAt).toLocaleString(locale)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </div>
      <div className="flex flex-col gap-4">
        <Card title={t('quickActions')}>
          <ul className="flex flex-col gap-2 text-sm">
            {can('project.settings.manage') ? (
              <li>
                <Link className="text-accent underline" href={`${base}/settings?tab=general`}>
                  {t('editProject')}
                </Link>
              </li>
            ) : null}
            {can('project.environments.manage') ? (
              <li>
                <Link className="text-accent underline" href={`${base}/settings?tab=environments`}>
                  {t('manageEnvironments')}
                </Link>
              </li>
            ) : null}
            {can('project.bindings.manage') ? (
              <li>
                <Link className="text-accent underline" href={`${base}/settings?tab=bindings`}>
                  {t('manageBindings')}
                </Link>
              </li>
            ) : null}
            <li>
              <Link className="text-accent underline" href={`${base}/settings?tab=members`}>
                {t('viewMembers')}
              </Link>
            </li>
            {can('audit.read') ? (
              <li>
                <Link className="text-accent underline" href={`/${locale}/audit?projectKey=${p.key}`}>
                  {t('openAudit')}
                </Link>
              </li>
            ) : null}
          </ul>
        </Card>
        <Card title={t('upcoming')}>
          <p className="text-sm text-muted">{t('upcomingHint')}</p>
        </Card>
      </div>
    </div>
  );
}
