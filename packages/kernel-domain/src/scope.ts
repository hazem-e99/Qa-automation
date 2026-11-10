import { isUuid } from './uuid.js';

declare const brand: unique symbol;
export type ProjectId = string & { readonly [brand]: 'ProjectId' };
export type OrgId = string & { readonly [brand]: 'OrgId' };

/** Every project-owned query takes a ProjectScope (doc 07 §7, doc 21 §4). */
export interface ProjectScope {
  readonly orgId: OrgId;
  readonly projectId: ProjectId;
}

export function projectScope(orgId: string, projectId: string): ProjectScope {
  if (!isUuid(orgId)) throw new TypeError('orgId must be a UUID');
  if (!isUuid(projectId)) throw new TypeError('projectId must be a UUID');
  return Object.freeze({ orgId: orgId as OrgId, projectId: projectId as ProjectId });
}
