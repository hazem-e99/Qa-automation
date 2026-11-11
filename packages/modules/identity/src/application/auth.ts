import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  and,
  appendAudit,
  eq,
  organizations,
  orgMemberships,
  roles,
  sessions,
  sql,
  users,
  type Db,
  type Tx,
} from '@qos/db';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import argon2 from 'argon2';
import { assertPasswordAcceptable, normalizeEmail } from '../domain/password.js';
import { isRoleKey, type RoleKey } from '../domain/rbac.js';

/** argon2id parameters (OWASP baseline: 19 MiB memory, 2 iterations, 1 lane). */
const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
export const hashPassword = (password: string): Promise<string> => argon2.hash(password, ARGON);

/** Verified against when the account does not exist, so both cases take the same time. */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(24).toString('hex')));

export interface SessionPolicy {
  readonly idleMinutes: number;
  readonly absoluteDays: number;
}
export const DEFAULT_SESSION_POLICY: SessionPolicy = { idleMinutes: 8 * 60, absoluteDays: 7 };

export interface Principal {
  readonly kind: 'user';
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
  readonly displayName: string;
  /** Org- and platform-scope roles. Project roles are looked up per project. */
  readonly orgRoles: readonly RoleKey[];
  readonly sessionId: string;
}

export interface ClientInfo {
  readonly ip?: string | null;
  readonly ua?: string | null;
}

const sessionIdOf = (token: string): string => createHash('sha256').update(token).digest('hex');

/** CSRF token bound to the session: derived from the session token, so nothing extra is stored. */
export const csrfTokenFor = (sessionToken: string): string =>
  createHmac('sha256', sessionToken).update('qos-csrf-v1').digest('base64url');

export function csrfTokenMatches(sessionToken: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken));
  const given = Buffer.from(presented);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

async function roleId(tx: Tx | Db, key: RoleKey): Promise<string> {
  const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, key));
  if (!r) throw new Error(`role not seeded: ${key}`);
  return r.id;
}

export interface SetupInput {
  readonly orgName: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

/**
 * First-run setup: creates the organization and its first administrator. Works only while no
 * user exists; a transaction-scoped lock makes two concurrent attempts safe.
 */
export async function setupFirstAdmin(db: Db, input: SetupInput): Promise<{ orgId: string; userId: string }> {
  const email = normalizeEmail(input.email);
  const orgName = input.orgName.trim();
  const displayName = input.displayName.trim();
  if (orgName.length < 2 || orgName.length > 100) throw new DomainError('org.name_invalid');
  if (displayName.length < 1 || displayName.length > 100) throw new DomainError('user.display_name_invalid');
  assertPasswordAcceptable(input.password, [email]);
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('identity.setup'))`);
    const existing = await tx.execute<{ n: number }>(sql`select count(*)::int as n from identity.users`);
    if ((existing.rows[0]?.n ?? 0) > 0) throw new DomainError('setup.already_done');
    const orgId = uuidv7();
    const userId = uuidv7();
    const now = new Date();
    const slug =
      orgName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'org';
    await tx.insert(organizations).values({ id: orgId, name: orgName, slug, createdAt: now });
    await tx
      .insert(users)
      .values({ id: userId, orgId, email, displayName, passwordHash, status: 'active', createdAt: now });
    // Single-organization pilot: the first user operates the platform and administers the org.
    for (const key of ['org_admin', 'platform_admin'] as const) {
      await tx.insert(orgMemberships).values({ orgId, userId, roleId: await roleId(tx, key) });
    }
    await appendAudit(tx, {
      orgId,
      actorType: 'user',
      actorId: userId,
      action: 'identity.setup',
      targetType: 'organization',
      targetId: orgId,
      summary: { roles: ['org_admin', 'platform_admin'] },
      source: 'api',
    });
    return { orgId, userId };
  });
}

export interface LoginResult {
  /** Opaque session token for the cookie. Only its hash is stored. */
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
  readonly userId: string;
}

/**
 * Password login. Every failure returns the same error, and an unknown email costs the same
 * hashing time as a wrong password, so the response reveals nothing about which accounts exist.
 */
export async function login(
  db: Db,
  input: { email: string; password: string },
  client: ClientInfo = {},
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): Promise<LoginResult> {
  const failed = new DomainError('auth.invalid_credentials');
  let email: string;
  try {
    email = normalizeEmail(input.email);
  } catch {
    await argon2.verify(await getDummyHash(), String(input.password ?? '')).catch(() => false);
    throw failed;
  }
  const [user] = await db.select().from(users).where(eq(users.email, email));
  const hash = user?.passwordHash ?? (await getDummyHash());
  const ok = await argon2.verify(hash, String(input.password ?? '')).catch(() => false);
  if (!user || !user.passwordHash || !ok || user.status !== 'active') {
    if (user) {
      await db.transaction((tx) =>
        appendAudit(tx, {
          orgId: user.orgId,
          actorType: 'user',
          actorId: user.id,
          action: 'identity.login.failed',
          targetType: 'user',
          targetId: user.id,
          summary: { reason: user.status !== 'active' ? 'inactive' : 'bad_password' },
          source: 'api',
          ip: client.ip ?? null,
        }),
      );
    }
    throw failed;
  }

  // A new token on every login (no session fixation). The token never touches the database.
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + policy.absoluteDays * 86_400_000);
  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      id: sessionIdOf(token),
      userId: user.id,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      ip: client.ip ?? null,
      ua: client.ua?.slice(0, 300) ?? null,
    });
    await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
    await appendAudit(tx, {
      orgId: user.orgId,
      actorType: 'user',
      actorId: user.id,
      action: 'identity.login',
      targetType: 'user',
      targetId: user.id,
      summary: {},
      source: 'api',
      ip: client.ip ?? null,
    });
  });
  return { token, csrfToken: csrfTokenFor(token), expiresAt, userId: user.id };
}

/**
 * Resolves a session token to a principal, or null when the session is unknown, expired, idle
 * too long, or belongs to a user who is no longer active.
 */
export async function resolveSession(
  db: Db,
  token: string | null | undefined,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  now: Date = new Date(),
): Promise<Principal | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const id = sessionIdOf(token);
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id));
  if (!row) return null;
  const idleMs = policy.idleMinutes * 60_000;
  const dead =
    row.user.status !== 'active' ||
    row.session.expiresAt.getTime() <= now.getTime() ||
    now.getTime() - row.session.lastSeenAt.getTime() > idleMs;
  if (dead) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  // Touch at most once a minute: keeps the idle timer accurate without a write per request.
  if (now.getTime() - row.session.lastSeenAt.getTime() > 60_000) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
  }
  const memberships = await db
    .select({ key: roles.key })
    .from(orgMemberships)
    .innerJoin(roles, eq(roles.id, orgMemberships.roleId))
    .where(and(eq(orgMemberships.userId, row.user.id), eq(orgMemberships.orgId, row.user.orgId)));
  return {
    kind: 'user',
    userId: row.user.id,
    orgId: row.user.orgId,
    email: row.user.email,
    displayName: row.user.displayName,
    orgRoles: memberships.map((m) => m.key).filter(isRoleKey),
    sessionId: id,
  };
}

export async function logout(db: Db, principal: Principal): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.id, principal.sessionId));
    await appendAudit(tx, {
      orgId: principal.orgId,
      actorType: 'user',
      actorId: principal.userId,
      action: 'identity.logout',
      targetType: 'user',
      targetId: principal.userId,
      summary: {},
      source: 'api',
    });
  });
}

/** Housekeeping for a scheduled job in a later batch. Returns the number of sessions removed. */
export async function purgeExpiredSessions(
  db: Db,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): Promise<number> {
  const res = await db.execute(
    sql`delete from identity.sessions
        where expires_at <= now() or last_seen_at < now() - make_interval(mins => ${policy.idleMinutes})`,
  );
  return res.rowCount ?? 0;
}
