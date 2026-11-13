import { randomBytes } from 'node:crypto';
import {
  and,
  appendAudit,
  eq,
  invitations,
  isNull,
  organizations,
  orgMemberships,
  projectMemberships,
  roles,
  users,
  type Db,
  type Tx,
} from '@qos/db';
import { appendOutbox } from '@qos/jobs';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import { assertPasswordAcceptable, normalizeEmail } from '../domain/password.js';
import { isRoleKey, ROLES, type RoleKey } from '../domain/rbac.js';
import {
  hashOpaque,
  hashPassword,
  issueSession,
  type ClientInfo,
  type Principal,
  type SessionIssued,
  type SessionPolicy,
} from './auth.js';

/**
 * Invitations (T-P2-03, M13-FR-01). The invite creates the account in status `invited`; the
 * link (72 h) lets the person choose a name and password. Email delivery is class O (n8n, P7):
 * until then the administrator copies the link from the UI, which is always available.
 */
export const INVITATION_HOURS = 72;

export interface InvitationView {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly orgRole: string | null;
  readonly projectId: string | null;
  readonly projectRole: string | null;
  readonly status: 'pending' | 'expired' | 'accepted' | 'revoked';
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

const view = (i: typeof invitations.$inferSelect, now = new Date()): InvitationView => ({
  id: i.id,
  userId: i.userId,
  email: i.email,
  orgRole: i.orgRole,
  projectId: i.projectId,
  projectRole: i.projectRole,
  status: i.acceptedAt ? 'accepted' : i.revokedAt ? 'revoked' : i.expiresAt <= now ? 'expired' : 'pending',
  expiresAt: i.expiresAt,
  createdAt: i.createdAt,
});

export interface NewInvitation {
  readonly email: string;
  readonly displayName?: string | undefined;
  /** Only `org_admin` can be granted by invitation; platform roles never. */
  readonly orgRole?: 'org_admin' | null | undefined;
  /** Optional first project membership. The caller checks that the project exists in the org. */
  readonly projectId?: string | null | undefined;
  readonly projectRole?: string | null | undefined;
}

const newToken = () => randomBytes(32).toString('base64url');

export async function createInvitation(
  db: Db,
  actor: Principal,
  input: NewInvitation,
  now: Date = new Date(),
): Promise<{ invitation: InvitationView; token: string }> {
  const email = normalizeEmail(input.email);
  if (input.orgRole != null && input.orgRole !== 'org_admin')
    throw new DomainError('invitation.role_invalid');
  const projectRole = input.projectRole ?? null;
  if ((projectRole === null) !== (input.projectId == null))
    throw new DomainError('invitation.project_role_required');
  if (projectRole !== null && !(isRoleKey(projectRole) && ROLES[projectRole].scope === 'project')) {
    throw new DomainError('member.role_invalid');
  }
  const displayName = (input.displayName ?? '').trim() || email.split('@')[0]!;
  if (displayName.length > 100) throw new DomainError('user.display_name_invalid');
  const token = newToken();
  const expiresAt = new Date(now.getTime() + INVITATION_HOURS * 3_600_000);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(users)
      .where(and(eq(users.orgId, actor.orgId), eq(users.email, email)))
      .for('update');
    if (existing && existing.status !== 'invited') throw new DomainError('user.exists');
    const userId = existing?.id ?? uuidv7();
    if (existing) {
      // Inviting again replaces any open invitation for the same person.
      await tx
        .update(invitations)
        .set({ revokedAt: now })
        .where(
          and(eq(invitations.userId, userId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)),
        );
      await tx.update(users).set({ displayName }).where(eq(users.id, userId));
    } else {
      await tx
        .insert(users)
        .values({ id: userId, orgId: actor.orgId, email, displayName, status: 'invited', createdAt: now });
    }
    const id = uuidv7();
    const [row] = await tx
      .insert(invitations)
      .values({
        id,
        orgId: actor.orgId,
        userId,
        email,
        orgRole: input.orgRole ?? null,
        projectId: input.projectId ?? null,
        projectRole,
        tokenHash: hashOpaque(token),
        invitedBy: actor.userId,
        expiresAt,
        createdAt: now,
      })
      .returning();
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.user.invited',
      targetType: 'user',
      targetId: userId,
      projectId: input.projectId ?? null,
      summary: { invitationId: id, orgRole: input.orgRole ?? null, projectRole },
      source: 'api',
    });
    await appendOutbox(tx, {
      type: 'user.invited',
      aggregateType: 'user',
      aggregateId: userId,
      projectId: input.projectId ?? null,
      // No token in the event: the link is only ever returned to the inviting administrator.
      payload: { invitationId: id, expiresAt: expiresAt.toISOString() },
    });
    return { invitation: view(row!, now), token };
  });
}

/** Open and recently closed invitations, newest first. */
export async function listInvitations(db: Db, orgId: string): Promise<InvitationView[]> {
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.orgId, orgId))
    .orderBy(invitations.createdAt);
  return rows.reverse().map((r) => view(r));
}

async function lockedInvitation(tx: Tx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, id), eq(invitations.orgId, orgId)))
    .for('update');
  if (!row) throw new DomainError('invitation.not_found');
  return row;
}

/** New link and a fresh 72 h for an open or expired invitation (M13 §13). The old link stops working. */
export async function resendInvitation(
  db: Db,
  actor: Principal,
  id: string,
  now: Date = new Date(),
): Promise<{ invitation: InvitationView; token: string }> {
  const token = newToken();
  return db.transaction(async (tx) => {
    const row = await lockedInvitation(tx, actor.orgId, id);
    if (row.acceptedAt || row.revokedAt) throw new DomainError('invitation.closed');
    const expiresAt = new Date(now.getTime() + INVITATION_HOURS * 3_600_000);
    const [updated] = await tx
      .update(invitations)
      .set({ tokenHash: hashOpaque(token), expiresAt })
      .where(eq(invitations.id, id))
      .returning();
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.invitation.resent',
      targetType: 'user',
      targetId: row.userId,
      summary: { invitationId: id },
      source: 'api',
    });
    return { invitation: view(updated!, now), token };
  });
}

/** Withdraws an invitation. The invited account, which never had access, is removed with it. */
export async function revokeInvitation(
  db: Db,
  actor: Principal,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockedInvitation(tx, actor.orgId, id);
    if (row.acceptedAt) throw new DomainError('invitation.closed');
    await tx
      .update(invitations)
      .set({ revokedAt: row.revokedAt ?? now })
      .where(eq(invitations.id, id));
    const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, row.userId));
    if (u?.status === 'invited') await tx.delete(users).where(eq(users.id, row.userId));
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.invitation.revoked',
      targetType: 'user',
      targetId: row.userId,
      summary: { invitationId: id, email: row.email },
      source: 'api',
    });
  });
}

async function openInvitation(db: Db | Tx, token: string, now: Date) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const [row] = await db
    .select({ invitation: invitations, orgName: organizations.name })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(eq(invitations.tokenHash, hashOpaque(token)));
  if (!row || row.invitation.acceptedAt || row.invitation.revokedAt || row.invitation.expiresAt <= now)
    return null;
  return row;
}

/** What the accept page shows before the person signs up. Invalid, used and expired look the same. */
export async function lookupInvitation(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<{ email: string; orgName: string; displayName: string; expiresAt: Date }> {
  const row = await openInvitation(db, token, now);
  if (!row) throw new DomainError('invitation.invalid');
  const [u] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, row.invitation.userId));
  return {
    email: row.invitation.email,
    orgName: row.orgName,
    displayName: u?.displayName ?? '',
    expiresAt: row.invitation.expiresAt,
  };
}

/**
 * Accepts an invitation: sets name and password, activates the account, grants the invited
 * roles and signs the person in. Single use, even under concurrent requests.
 */
export async function acceptInvitation(
  db: Db,
  input: { token: string; displayName: string; password: string },
  client: ClientInfo,
  policy: SessionPolicy,
  now: Date = new Date(),
): Promise<SessionIssued> {
  const found = await openInvitation(db, input.token, now);
  if (!found) throw new DomainError('invitation.invalid');
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 100) throw new DomainError('user.display_name_invalid');
  assertPasswordAcceptable(input.password, [found.invitation.email]);
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const inv = await lockedInvitation(tx, found.invitation.orgId, found.invitation.id);
    if (
      inv.acceptedAt ||
      inv.revokedAt ||
      inv.expiresAt <= now ||
      inv.tokenHash !== found.invitation.tokenHash
    ) {
      throw new DomainError('invitation.invalid');
    }
    const [user] = await tx.select().from(users).where(eq(users.id, inv.userId)).for('update');
    if (!user || user.status !== 'invited') throw new DomainError('invitation.invalid');
    await tx.update(users).set({ displayName, passwordHash, status: 'active' }).where(eq(users.id, user.id));
    await tx.update(invitations).set({ acceptedAt: now }).where(eq(invitations.id, inv.id));
    const roleIdOf = async (key: RoleKey) => {
      const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, key));
      if (!r) throw new Error(`role not seeded: ${key}`);
      return r.id;
    };
    if (inv.orgRole === 'org_admin') {
      await tx
        .insert(orgMemberships)
        .values({ orgId: inv.orgId, userId: user.id, roleId: await roleIdOf('org_admin') })
        .onConflictDoNothing();
    }
    if (inv.projectId && inv.projectRole && isRoleKey(inv.projectRole)) {
      await tx
        .insert(projectMemberships)
        .values({ projectId: inv.projectId, userId: user.id, roleId: await roleIdOf(inv.projectRole) })
        .onConflictDoNothing();
    }
    await appendAudit(tx, {
      orgId: inv.orgId,
      actorType: 'user',
      actorId: user.id,
      action: 'identity.invitation.accepted',
      targetType: 'user',
      targetId: user.id,
      projectId: inv.projectId,
      summary: { invitationId: inv.id, invitedBy: inv.invitedBy },
      source: 'api',
    });
    await appendOutbox(tx, {
      type: 'user.activated',
      aggregateType: 'user',
      aggregateId: user.id,
      payload: { via: 'invitation' },
    });
    return issueSession(tx, { id: user.id, orgId: inv.orgId }, client, policy, 'password');
  });
}
