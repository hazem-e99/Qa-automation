import type { ProjectPermissionsResponse, ProjectResponse } from '@qos/contracts';
import { setRequestLocale } from 'next-intl/server';
import { SETTINGS_TABS } from '@/lib/settings-tabs';
import { serverGet } from '@/lib/server-api';
import { ApprovalsTab } from './approvals-tab';
import { BindingsTab } from './bindings-tab';
import { EnvironmentsTab } from './environments-tab';
import { GeneralTab } from './general-tab';
import { MappingsTab } from './mappings-tab';
import { MembersTab } from './members-tab';
import { RulesTab } from './rules-tab';

export const dynamic = 'force-dynamic';

/** Project settings (T-P2-16): one tab per section; each tab loads and saves on its own. */
export default async function ProjectSettings({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; key: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { locale, key } = await params;
  setRequestLocale(locale);
  const { tab: raw } = await searchParams;
  const tab = (SETTINGS_TABS as readonly string[]).includes(raw ?? '') ? raw! : 'general';
  const k = encodeURIComponent(key);
  const [project, perms] = await Promise.all([
    serverGet<ProjectResponse>(`/projects/${k}`),
    serverGet<ProjectPermissionsResponse>(`/projects/${k}/permissions`),
  ]);
  const p = project.data!;
  const permissions = [...(perms.data?.project ?? []), ...(perms.data?.org ?? [])];
  const props = { project: p, permissions };
  return (
    <div data-testid={`settings-${tab}`}>
      {tab === 'general' ? <GeneralTab {...props} /> : null}
      {tab === 'environments' ? <EnvironmentsTab {...props} /> : null}
      {tab === 'bindings' ? <BindingsTab {...props} /> : null}
      {tab === 'mappings' ? <MappingsTab {...props} /> : null}
      {tab === 'rules' ? <RulesTab {...props} /> : null}
      {tab === 'members' ? <MembersTab {...props} /> : null}
      {tab === 'approvals' ? <ApprovalsTab {...props} /> : null}
    </div>
  );
}
