import { and, appendAudit, eq, inArray, projectKeySequences, projects, sql, type Db, type Tx } from '@qos/db';
import { addInitialProjectMember, grantFor, type Principal } from '@qos/identity';
import { appendOutbox } from '@qos/jobs';
import { DomainError, uuidv7 } from '@qos/kernel-domain';

export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
export type ProjectStatus = 'draft' | 'active' | 'archived' | 'deleted';

export interface Project {
  readonly id: string;
  readonly orgId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly status: ProjectStatus;
  /** Demo projects may bind demo (mock) connections; real projects never can. */
  readonly isDemo: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type Row = typeof projects.$inferSelect;
const toProject = (r: Row): Project => ({
  id: r.id,
  orgId: r.orgId,
  key: r.key,
  name: r.name,
  description: r.description,
  tags: r.tags,
  status: r.status as ProjectStatus,
  isDemo: r.isDemo,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const cleanTags = (tags: readonly string[] | undefined): string[] =>
  [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);

export interface CreateProjectInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly isDemo?: boolean;
}

/**
 * Creates a project (BR-M02-1). The creator becomes its first `qa_lead`, so the project is never
 * without someone who can manage it.
 */
export async function createProject(
  db: Db,
  actor: Principal,
  input: CreateProjectInput,
  tx?: Tx,
): Promise<Project> {
  if (!PROJECT_KEY_RE.test(input.key)) throw new DomainError('project.key_invalid');
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new DomainError('project.name_invalid');
  const write = async (t: Tx): Promise<Project> => {
    const taken = await t
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, actor.orgId), eq(projects.key, input.key)));
    // Keys of deleted projects stay reserved: old human-readable ids must never point elsewhere.
    if (taken.length) throw new DomainError('project.key_taken');
    const now = new Date();
    const [row] = await t
      .insert(projects)
      .values({
        id: uuidv7(),
        orgId: actor.orgId,
        key: input.key,
        name,
        description: (input.description ?? '').trim().slice(0, 2000),
        tags: cleanTags(input.tags),
        status: 'active',
        isDemo: input.isDemo === true,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await addInitialProjectMember(t, row!.id, actor.userId, 'qa_lead');
    await appendAudit(t, {
      orgId: actor.orgId,
      projectId: row!.id,
      actorType: 'user',
      actorId: actor.userId,
      action: 'project.created',
      targetType: 'project',
      targetId: row!.id,
      summary: { key: row!.key },
      source: 'api',
    });
    await appendOutbox(t, {
      type: 'project.created',
      aggregateType: 'project',
      aggregateId: row!.id,
      projectId: row!.id,
      payload: { key: row!.key },
    });
    return toProject(row!);
  };
  return tx ? write(tx) : db.transaction(write);
}

/** Looks a project up by key inside one organization. Deleted projects do not exist for callers. */
export async function findProjectByKey(db: Db | Tx, orgId: string, key: string): Promise<Project | null> {
  if (!PROJECT_KEY_RE.test(key)) return null;
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.key, key)));
  return row && row.status !== 'deleted' ? toProject(row) : null;
}

/** Looks a project up by id inside one organization; another organization's project is null. */
export async function findProjectById(db: Db | Tx, orgId: string, id: string): Promise<Project | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, id)));
  return row && row.status !== 'deleted' ? toProject(row) : null;
}

/**
 * Projects the principal may see: every project of the organization for roles that the matrix
 * grants `project.read` org-wide, otherwise only the projects they are a member of.
 */
export async function listProjects(
  db: Db,
  principal: Principal,
  opts: { includeArchived?: boolean } = {},
): Promise<Project[]> {
  const statuses: ProjectStatus[] = opts.includeArchived
    ? ['draft', 'active', 'archived']
    : ['draft', 'active'];
  const seesAll = principal.orgRoles.some((r) => grantFor(r, 'project.read') === 'granted');
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.orgId, principal.orgId),
        inArray(projects.status, statuses),
        seesAll
          ? undefined
          : sql`exists (select 1 from identity.project_memberships m
                        where m.project_id = ${projects.id} and m.user_id = ${principal.userId})`,
      ),
    )
    .orderBy(projects.key);
  return rows.map(toProject);
}

/** Write endpoints of an archived project answer 409 `project_archived` (M02-AC-07). */
export function assertProjectWritable(project: Project): void {
  if (project.status === 'archived') throw new DomainError('project_archived');
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

export async function updateProject(
  db: Db,
  actor: Principal,
  project: Project,
  input: UpdateProjectInput,
): Promise<Project> {
  assertProjectWritable(project);
  const patch: Partial<Row> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 120) throw new DomainError('project.name_invalid');
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = input.description.trim().slice(0, 2000);
  if (input.tags !== undefined) patch.tags = cleanTags(input.tags);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(projects)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(projects.id, project.id), inArray(projects.status, ['draft', 'active'])))
      .returning();
    if (!row) throw new DomainError('project_archived');
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: actor.userId,
      action: 'project.updated',
      targetType: 'project',
      targetId: project.id,
      summary: { fields: Object.keys(patch).sort() },
      source: 'api',
    });
    return toProject(row);
  });
}

/** Lifecycle moves with expected-state checks, so a repeated request cannot skip a state. */
async function transition(
  db: Db,
  actor: Principal,
  project: Project,
  from: ProjectStatus[],
  to: ProjectStatus,
  action: string,
): Promise<Project> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(projects)
      .set({ status: to, updatedAt: now, deletedAt: to === 'deleted' ? now : null })
      .where(and(eq(projects.id, project.id), inArray(projects.status, from)))
      .returning();
    if (!row) throw new DomainError('project.invalid_state', { status: project.status });
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: actor.userId,
      action,
      targetType: 'project',
      targetId: project.id,
      summary: { from: project.status, to },
      source: 'api',
    });
    await appendOutbox(tx, {
      type: action,
      aggregateType: 'project',
      aggregateId: project.id,
      projectId: project.id,
      payload: { key: project.key, status: to },
    });
    return toProject(row);
  });
}

export const archiveProject = (db: Db, actor: Principal, project: Project) =>
  transition(db, actor, project, ['draft', 'active'], 'archived', 'project.archived');
export const restoreProject = (db: Db, actor: Principal, project: Project) =>
  transition(db, actor, project, ['archived'], 'active', 'project.restored');
/** Soft delete (BR-M02-7). Purging after 30 days is a scheduled job in a later batch. */
export const deleteProject = (db: Db, actor: Principal, project: Project) =>
  transition(db, actor, project, ['draft', 'active', 'archived'], 'deleted', 'project.deleted');

/**
 * Next number of a per-project sequence, for human-readable ids (e.g. PAY-REQ-12). Atomic: the
 * row lock of the upsert serializes concurrent callers, and a rolled-back transaction leaves no gap.
 */
export async function nextSequenceValue(tx: Tx, projectId: string, entityType: string): Promise<number> {
  const [row] = await tx
    .insert(projectKeySequences)
    .values({ projectId, entityType, nextValue: 2 })
    .onConflictDoUpdate({
      target: [projectKeySequences.projectId, projectKeySequences.entityType],
      set: { nextValue: sql`${projectKeySequences.nextValue} + 1` },
    })
    .returning({ next: projectKeySequences.nextValue });
  return row!.next - 1;
}

export const formatEntityKey = (projectKey: string, prefix: string, n: number): string =>
  `${projectKey}-${prefix}-${n}`;
