import { and, appendAudit, eq, projectMemberships, roles, sql, users, type Db, type Tx } from '@qos/db';
import { DomainError } from '@qos/kernel-domain';
import { isRoleKey, ROLE_RANK, ROLES, type RoleKey } from '../domain/rbac.js';
import type { Principal } from './auth.js';

export interface ProjectMember {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: RoleKey;
}

const isProjectRole = (role: string): role is RoleKey => isRoleKey(role) && ROLES[role].scope === 'project';

async function roleIdOf(db: Db | Tx, key: RoleKey): Promise<string> {
  const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, key));
  if (!r) throw new Error(`role not seeded: ${key}`);
  return r.id;
}

export async function projectRoleOf(db: Db | Tx, projectId: string, userId: string): Promise<RoleKey | null> {
  const [m] = await db
    .select({ key: roles.key })
    .from(projectMemberships)
    .innerJoin(roles, eq(roles.id, projectMemberships.roleId))
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)));
  return m && isRoleKey(m.key) ? m.key : null;
}

/** Highest rank the actor holds for this project: their project role or an org-level role. */
async function actorRank(db: Db | Tx, actor: Principal, projectId: string): Promise<number> {
  const own = await projectRoleOf(db, projectId, actor.userId);
  return Math.max(0, ...actor.orgRoles.map((r) => ROLE_RANK[r]), own ? ROLE_RANK[own] : 0);
}

/** Used when a project is created: its creator becomes the first member. No rank checks. */
export async function addInitialProjectMember(
  tx: Tx,
  projectId: string,
  userId: string,
  role: RoleKey,
): Promise<void> {
  await tx.insert(projectMemberships).values({ projectId, userId, roleId: await roleIdOf(tx, role) });
}

/**
 * Adds a member or changes their role (BR-M13-3): nobody changes their own role, grants a role
 * above their own, or changes a member who outranks them.
 */
export async function setProjectMember(
  db: Db,
  actor: Principal,
  projectId: string,
  userId: string,
  role: string,
): Promise<ProjectMember> {
  if (!isProjectRole(role)) throw new DomainError('member.role_invalid');
  if (userId === actor.userId) throw new DomainError('member.cannot_change_own_role');
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, actor.orgId)));
    if (!user || user.status === 'deactivated') throw new DomainError('member.user_not_found');
    const rank = await actorRank(tx, actor, projectId);
    const current = await projectRoleOf(tx, projectId, userId);
    if (ROLE_RANK[role] > rank || (current && ROLE_RANK[current] > rank)) {
      throw new DomainError('member.role_above_own');
    }
    const roleId = await roleIdOf(tx, role);
    await tx
      .insert(projectMemberships)
      .values({ projectId, userId, roleId })
      .onConflictDoUpdate({
        target: [projectMemberships.projectId, projectMemberships.userId],
        set: { roleId },
      });
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId,
      actorType: 'user',
      actorId: actor.userId,
      action: current ? 'project.member.role_changed' : 'project.member.added',
      targetType: 'user',
      targetId: userId,
      summary: { role, previousRole: current },
      source: 'api',
    });
    return { userId, email: user.email, displayName: user.displayName, role };
  });
}

export async function removeProjectMember(
  db: Db,
  actor: Principal,
  projectId: string,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await projectRoleOf(tx, projectId, userId);
    if (!current) throw new DomainError('member.not_found');
    if (userId !== actor.userId && ROLE_RANK[current] > (await actorRank(tx, actor, projectId))) {
      throw new DomainError('member.role_above_own');
    }
    // A project must keep someone who can manage it.
    if (current === 'qa_lead') {
      const leads = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from identity.project_memberships m
            join identity.roles r on r.id = m.role_id
            where m.project_id = ${projectId} and r.key = 'qa_lead'`,
      );
      if ((leads.rows[0]?.n ?? 0) <= 1) throw new DomainError('member.last_lead');
    }
    await tx
      .delete(projectMemberships)
      .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)));
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'project.member.removed',
      targetType: 'user',
      targetId: userId,
      summary: { role: current },
      source: 'api',
    });
  });
}

export async function listProjectMembers(db: Db | Tx, projectId: string): Promise<ProjectMember[]> {
  const rows = await db
    .select({ userId: users.id, email: users.email, displayName: users.displayName, role: roles.key })
    .from(projectMemberships)
    .innerJoin(users, eq(users.id, projectMemberships.userId))
    .innerJoin(roles, eq(roles.id, projectMemberships.roleId))
    .where(eq(projectMemberships.projectId, projectId))
    .orderBy(users.email);
  return rows.filter((r): r is ProjectMember => isRoleKey(r.role));
}

/** Active users holding `org_admin` in an organization. */
export async function listOrgAdmins(db: Db | Tx, orgId: string): Promise<string[]> {
  const rows = await db.execute<{ user_id: string }>(
    sql`select u.id as user_id from identity.org_memberships om
        join identity.roles r on r.id = om.role_id
        join identity.users u on u.id = om.user_id
        where om.org_id = ${orgId} and r.key = 'org_admin' and u.status = 'active'`,
  );
  return rows.rows.map((r) => r.user_id);
}
