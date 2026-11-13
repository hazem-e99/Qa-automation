import type { ProjectPermissionsResponse, ProjectResponse } from '@qos/contracts';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ProjectTabs } from '@/components/project-tabs';
import { Badge } from '@/components/ui';
import { serverGet } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/** Project header and tabs. A project the caller cannot see is a 404, exactly as in the API. */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string; key: string }>;
}) {
  const { locale, key } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('project');
  const project = await serverGet<ProjectResponse>(`/projects/${encodeURIComponent(key)}`);
  if (!project.data) notFound();
  const perms = (
    await serverGet<ProjectPermissionsResponse>(`/projects/${encodeURIComponent(key)}/permissions`)
  ).data;
  const p = project.data;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold" data-testid="page-title">
          {p.name}
        </h1>
        <bdi dir="ltr" className="font-mono text-sm text-muted">
          {p.key}
        </bdi>
        {p.isDemo ? <Badge tone="accent">{t('demo')}</Badge> : null}
        {p.status !== 'active' ? <Badge tone="warning">{t(`status_${p.status}`)}</Badge> : null}
      </div>
      <ProjectTabs projectKey={p.key} canSettings={perms?.project.includes('project.read') ?? false} />
      {children}
    </div>
  );
}
