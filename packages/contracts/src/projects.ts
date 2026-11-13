import { z } from 'zod';
import { Uuid } from './common.js';

const Tags = z.array(z.string().trim().min(1).max(40)).max(20);

export const CreateProjectRequest = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().max(2000).optional(),
  tags: Tags.optional(),
  /** Demo project: may use the mock connections. Only offered when demo mode is on. */
  isDemo: z.boolean().optional(),
  /** Built-in template id (`builtin-…`) or an organization template id (M02-FR-02). */
  templateId: z.string().min(1).max(60).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** `key` is accepted by the parser only so the API can answer 422: keys are immutable (M02-AC-06). */
export const UpdateProjectRequest = z.object({
  key: z.unknown().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().max(2000).optional(),
  tags: Tags.optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const ProjectResponse = z.object({
  id: Uuid,
  key: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  status: z.enum(['draft', 'active', 'archived']),
  isDemo: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProjectResponse = z.infer<typeof ProjectResponse>;

export const SetMemberRequest = z.object({ role: z.string().min(1).max(40) });
export type SetMemberRequest = z.infer<typeof SetMemberRequest>;

export const MemberResponse = z.object({
  userId: Uuid,
  email: z.string(),
  displayName: z.string(),
  role: z.string(),
});
export type MemberResponse = z.infer<typeof MemberResponse>;

export const ProjectPermissionsResponse = z.object({
  org: z.array(z.string()),
  project: z.array(z.string()),
});
export type ProjectPermissionsResponse = z.infer<typeof ProjectPermissionsResponse>;

export const ProjectTemplateResponse = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  builtin: z.boolean(),
  settingsSections: z.array(z.string()),
  environments: z.array(z.string()),
  createdAt: z.iso.datetime().nullable(),
});
export type ProjectTemplateResponse = z.infer<typeof ProjectTemplateResponse>;
export const SaveTemplateRequest = z
  .object({ name: z.string().trim().min(2).max(80), description: z.string().max(500).optional() })
  .strict();
export const CloneProjectRequest = z
  .object({ key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), name: z.string().trim().min(2).max(120) })
  .strict();
