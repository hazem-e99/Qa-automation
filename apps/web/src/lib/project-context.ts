import type { ProjectPermissionsResponse, ProjectResponse } from '@qos/contracts';
import { notFound } from 'next/navigation';
import { serverGet } from './server-api';

/** The project and the caller's permissions in it (project and org), for project pages. */
export async function projectContext(
  key: string,
): Promise<{ project: ProjectResponse; permissions: string[] }> {
  const k = encodeURIComponent(key);
  const [project, perms] = await Promise.all([
    serverGet<ProjectResponse>(`/projects/${k}`),
    serverGet<ProjectPermissionsResponse>(`/projects/${k}/permissions`),
  ]);
  if (!project.data) notFound();
  return {
    project: project.data,
    permissions: [...(perms.data?.project ?? []), ...(perms.data?.org ?? [])],
  };
}
