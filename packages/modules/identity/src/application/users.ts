import { randomBytes } from 'node:crypto';
import {
  and,
  appendAudit,
  eq,
  isNull,
  mfaChallenges,
  orgMemberships,
  passwordResets,
  roles,
  sessions,
  sql,
  users,
  type Db,
  type Tx,
} from '@qos/db';
import { appendOutbox } from '@qos/jobs';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import argon2 from 'argon2';
import { assertPasswordAcceptable } from '../domain/password.js';
import { isRoleKey, type RoleKey } from '../domain/rbac.js';
import { hashOpaque, hashPassword, type Principal } from './auth.js';

/** User administration and self-service profile (M13-FR-01, BR-M13-4/5). */
export const USER_LOCALES = ['en', 'ar'] as const;
export const PASSWORD_RESET_HOURS = 24;

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: 'invited' | 'active' | 'deactivated';
  readonly orgRoles: RoleKey[];
  readonly locale: string;
  readonly timezone: string;
  readonly mfaEnabled: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

async function orgRolesByUser(db: Db | Tx, orgId: string): Promise<Map<string, RoleKey[]>> {
  const rows = await db
    .select({ userId: orgMemberships.userId, key: roles.key })
    .from(orgMemberships)
    .innerJoin(roles, eq(roles.id, orgMemberships.roleId))
    .where(eq(orgMemberships.orgId, orgId));
  const map = new Map<string, RoleKey[]>();
  for (const r of rows) if (isRoleKey(r.key)) map.set(r.userId, [...(map.get(r.userId) ?? []), r.key]);
  return map;
}

const summarize = (u: typeof users.$inferSelect, orgRoles: RoleKey[]): UserSummary => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  status: u.status as UserSummary['status'],
  orgRoles: [...orgRoles].sort(),
  locale: u.locale,
  timezone: u.timezone,
  mfaEnabled: u.mfaEnabledAt !== null,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

export async function listUsers(db: Db, orgId: string): Promise<UserSummary[]> {
  const [rows, rolesOf] = await Promise.all([
    db.select().from(users).where(eq(users.orgId, orgId)).orderBy(users.email),
    orgRolesByUser(db, orgId),
  ]);
  return rows.map((u) => summarize(u, rolesOf.get(u.id) ?? []));
}

export async function getUser(db: Db | Tx, orgId: string, userId: string): Promise<UserSummary> {
  const [u] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)));
  if (!u) throw new DomainError('user.not_found');
  return summarize(u, (await orgRolesByUser(db, orgId)).get(u.id) ?? []);
}

function validProfile(input: { displayName?: string; locale?: string; timezone?: string }) {
  const out: { displayName?: string; locale?: string; timezone?: string } = {};
  if (input.displayName !== undefined) {
    const name = input.displayName.trim();
    if (name.length < 1 || name.length > 100) throw new DomainError('user.display_name_invalid');
    out.displayName = name;
  }
  if (input.locale !== undefined) {
    if (!(USER_LOCALES as readonly string[]).includes(input.locale))
      throw new DomainError('user.locale_invalid');
    out.locale = input.locale;
  }
  if (input.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timezone });
    } catch {
      throw new DomainError('user.timezone_invalid');
    }
    out.timezone = input.timezone;
  }
  return out;
}

/** Serializes changes to org administrators, so "last admin" checks cannot race. */
const lockOrgAdmins = (tx: Tx, orgId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext('identity.org_admins'), hashtext(${orgId}))`);

async function activeOrgAdminCount(tx: Tx, orgId: string, excludingUserId: string): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    select count(distinct u.id)::int as n
    from identity.org_memberships m
    join identity.roles r on r.id = m.role_id and r.key = 'org_admin'
    join identity.users u on u.id = m.user_id and u.status = 'active'
    where m.org_id = ${orgId} and u.id <> ${excludingUserId}`);
  return res.rows[0]?.n ?? 0;
}

async function roleId(tx: Tx, key: RoleKey): Promise<string> {
  const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, key));
  if (!r) throw new Error(`role not seeded: ${key}`);
  return r.id;
}

/**
 * Admin edit: profile fields and the `org_admin` role. Nobody changes their own role
 * (BR-M13-3), and the last active org administrator keeps the role (BR-M13-4).
 */
export async function updateUser(
  db: Db,
  actor: Principal,
  userId: string,
  input: { displayName?: string; locale?: string; timezone?: string; orgAdmin?: boolean },
): Promise<UserSummary> {
  const profile = validProfile(input);
  return db.transaction(async (tx) => {
    const current = await getUser(tx, actor.orgId, userId);
    const changed: string[] = Object.keys(profile);
    if (Object.keys(profile).length) await tx.update(users).set(profile).where(eq(users.id, userId));
    const isAdmin = current.orgRoles.includes('org_admin');
    if (input.orgAdmin !== undefined && input.orgAdmin !== isAdmin) {
      if (userId === actor.userId) throw new DomainError('member.cannot_change_own_role');
      await lockOrgAdmins(tx, actor.orgId);
      const adminRole = await roleId(tx, 'org_admin');
      if (input.orgAdmin) {
        await tx.insert(orgMemberships).values({ orgId: actor.orgId, userId, roleId: adminRole });
      } else {
        if ((await activeOrgAdminCount(tx, actor.orgId, userId)) === 0)
          throw new DomainError('user.last_org_admin');
        await tx
          .delete(orgMemberships)
          .where(
            and(
              eq(orgMemberships.orgId, actor.orgId),
              eq(orgMemberships.userId, userId),
              eq(orgMemberships.roleId, adminRole),
            ),
          );
      }
      // Privilege change: existing sessions of that user end, so new rights apply cleanly.
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      changed.push('orgAdmin');
      await appendOutbox(tx, {
        type: 'membership.changed',
        aggregateType: 'user',
        aggregateId: userId,
        payload: { scope: 'org', role: 'org_admin', granted: input.orgAdmin },
      });
    }
    if (changed.length) {
      await appendAudit(tx, {
        orgId: actor.orgId,
        actorType: 'user',
        actorId: actor.userId,
        action: 'identity.user.updated',
        targetType: 'user',
        targetId: userId,
        summary: { changed, ...(input.orgAdmin !== undefined ? { orgAdmin: input.orgAdmin } : {}) },
        source: 'api',
      });
    }
    return getUser(tx, actor.orgId, userId);
  });
}

/**
 * Deactivation is immediate (BR-M13-5): sessions and MFA challenges are deleted in the same
 * transaction, so the user's next request is 401. Memberships stay, for reactivation; audit
 * history is never touched.
 */
export async function deactivateUser(db: Db, actor: Principal, userId: string): Promise<UserSummary> {
  if (userId === actor.userId) throw new DomainError('user.cannot_deactivate_self');
  return db.transaction(async (tx) => {
    const current = await getUser(tx, actor.orgId, userId);
    if (current.status === 'deactivated') return current;
    if (current.orgRoles.includes('org_admin')) {
      await lockOrgAdmins(tx, actor.orgId);
      if ((await activeOrgAdminCount(tx, actor.orgId, userId)) === 0)
        throw new DomainError('user.last_org_admin');
    }
    await tx.update(users).set({ status: 'deactivated' }).where(eq(users.id, userId));
    const ended = await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
    await tx.delete(mfaChallenges).where(eq(mfaChallenges.userId, userId));
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.user.deactivated',
      targetType: 'user',
      targetId: userId,
      summary: { sessionsEnded: ended.length, previousStatus: current.status },
      source: 'api',
    });
    await appendOutbox(tx, {
      type: 'user.deactivated',
      aggregateType: 'user',
      aggregateId: userId,
      payload: {},
    });
    return getUser(tx, actor.orgId, userId);
  });
}

export async function reactivateUser(db: Db, actor: Principal, userId: string): Promise<UserSummary> {
  return db.transaction(async (tx) => {
    const current = await getUser(tx, actor.orgId, userId);
    if (current.status !== 'deactivated') throw new DomainError('user.not_deactivated');
    const [u] = await tx.select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
    // An invited user who never set a password goes back to `invited`, not `active`.
    const status = u?.hash ? 'active' : 'invited';
    await tx.update(users).set({ status }).where(eq(users.id, userId));
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.user.reactivated',
      targetType: 'user',
      targetId: userId,
      summary: { status },
      source: 'api',
    });
    await appendOutbox(tx, {
      type: 'user.activated',
      aggregateType: 'user',
      aggregateId: userId,
      payload: { via: 'reactivation' },
    });
    return getUser(tx, actor.orgId, userId);
  });
}

export async function updateOwnProfile(
  db: Db,
  principal: Principal,
  input: { displayName?: string; locale?: string; timezone?: string },
): Promise<UserSummary> {
  const profile = validProfile(input);
  return db.transaction(async (tx) => {
    if (Object.keys(profile).length) {
      await tx.update(users).set(profile).where(eq(users.id, principal.userId));
      await appendAudit(tx, {
        orgId: principal.orgId,
        actorType: 'user',
        actorId: principal.userId,
        action: 'identity.profile.updated',
        targetType: 'user',
        targetId: principal.userId,
        summary: { changed: Object.keys(profile) },
        source: 'api',
      });
    }
    return getUser(tx, principal.orgId, principal.userId);
  });
}

/** Changes the caller's password and ends their other sessions. */
export async function changeOwnPassword(
  db: Db,
  principal: Principal,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, principal.userId));
  const ok = u?.passwordHash
    ? await argon2.verify(u.passwordHash, input.currentPassword).catch(() => false)
    : false;
  if (!u || !ok) throw new DomainError('auth.invalid_credentials');
  assertPasswordAcceptable(input.newPassword, [u.email]);
  const hash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: hash }).where(eq(users.id, u.id));
    await tx.execute(
      sql`delete from identity.sessions where user_id = ${u.id} and id <> ${principal.sessionId}`,
    );
    await appendAudit(tx, {
      orgId: u.orgId,
      actorType: 'user',
      actorId: u.id,
      action: 'identity.password.changed',
      targetType: 'user',
      targetId: u.id,
      summary: { by: 'self' },
      source: 'api',
    });
  });
}

/**
 * Admin-generated reset link (M13 §13: available without email). The token is returned once;
 * creating a new link invalidates older unused ones.
 */
export async function createPasswordReset(
  db: Db,
  actor: Principal,
  userId: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_HOURS * 3_600_000);
  await db.transaction(async (tx) => {
    const target = await getUser(tx, actor.orgId, userId);
    if (target.status !== 'active') throw new DomainError('user.not_active');
    await tx
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
    await tx.insert(passwordResets).values({
      id: uuidv7(),
      userId,
      tokenHash: hashOpaque(token),
      createdBy: actor.userId,
      expiresAt,
      createdAt: now,
    });
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'identity.password.reset_link_created',
      targetType: 'user',
      targetId: userId,
      summary: { expiresAt: expiresAt.toISOString() },
      source: 'api',
    });
  });
  return { token, expiresAt };
}

/** Uses a reset link: sets the password, ends every session of that user. Single use. */
export async function completePasswordReset(
  db: Db,
  input: { token: string; password: string },
  now: Date = new Date(),
): Promise<void> {
  const invalid = new DomainError('password_reset.invalid');
  if (typeof input.token !== 'string' || input.token.length < 20 || input.token.length > 200) throw invalid;
  const [row] = await db
    .select({ reset: passwordResets, user: users })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(eq(passwordResets.tokenHash, hashOpaque(input.token)));
  if (!row || row.reset.usedAt || row.reset.expiresAt <= now || row.user.status !== 'active') throw invalid;
  assertPasswordAcceptable(input.password, [row.user.email]);
  const hash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    const used = await tx
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.id, row.reset.id), isNull(passwordResets.usedAt)))
      .returning({ id: passwordResets.id });
    if (used.length !== 1) throw invalid;
    await tx.update(users).set({ passwordHash: hash }).where(eq(users.id, row.user.id));
    await tx.delete(sessions).where(eq(sessions.userId, row.user.id));
    await appendAudit(tx, {
      orgId: row.user.orgId,
      actorType: 'user',
      actorId: row.user.id,
      action: 'identity.password.changed',
      targetType: 'user',
      targetId: row.user.id,
      summary: { by: 'reset_link', linkCreatedBy: row.reset.createdBy },
      source: 'api',
    });
  });
}
