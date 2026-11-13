import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { uuidv7 } from '@qos/kernel-domain';
import {
  allGrants,
  authorize,
  csrfTokenFor,
  csrfTokenMatches,
  hashPassword,
  login,
  logout,
  orgPermissionsOf,
  purgeExpiredSessions,
  resolveSession,
  setupFirstAdmin,
  syncRbacCatalog,
  type Principal,
  type RoleKey,
} from '../src/index.js';

/** Password login that must yield a session (these accounts have no MFA). */
async function loginSession(...args: Parameters<typeof login>) {
  const r = await login(...args);
  if (r.kind !== 'session') throw new Error('unexpected MFA challenge');
  return r;
}

const ADMIN = {
  orgName: 'Pilot Org',
  email: 'admin@example.test',
  displayName: 'Admin',
  password: 'correct horse battery',
};
let t: TestDatabase;
let admin: { orgId: string; userId: string };

beforeAll(async () => {
  t = await startTestDatabase();
  await syncRbacCatalog(t.db);
}, 180_000);
afterAll(async () => {
  await t?.stop();
});

const addUser = async (email: string, status = 'active') => {
  const id = uuidv7();
  await t.pool.query(
    `insert into identity.users (id, org_id, email, display_name, password_hash, status, created_at)
     values ($1, $2, $3, $4, $5, $6, now())`,
    [id, admin.orgId, email, email, await hashPassword('another long password'), status],
  );
  return id;
};
let projectSeq = 0;
const addProject = async (): Promise<string> => {
  const id = uuidv7();
  await t.pool.query(
    `insert into projects.projects (id, org_id, key, name, status, created_by, created_at, updated_at)
     values ($1, $2, $3, 'P', 'active', $4, now(), now())`,
    [id, admin.orgId, 'T' + String(++projectSeq), admin.userId],
  );
  return id;
};
const addProjectMember = async (projectId: string, userId: string, role: RoleKey) =>
  t.pool.query(
    'insert into identity.project_memberships (project_id, user_id, role_id) select $1, $2, id from identity.roles where key = $3',
    [projectId, userId, role],
  );
const principalOf = async (email: string, password = 'another long password'): Promise<Principal> => {
  const { token } = await loginSession(t.db, { email, password });
  return (await resolveSession(t.db, token))!;
};

describe('role catalog sync', () => {
  it('seeds roles, permissions and grants, and is idempotent', async () => {
    await syncRbacCatalog(t.db);
    const counts = await t.pool.query(
      `select (select count(*)::int from identity.roles) roles,
              (select count(*)::int from identity.role_permissions) grants`,
    );
    expect(counts.rows[0]).toEqual({ roles: 8, grants: allGrants().length });
  });

  it('removes a grant that is no longer in the catalog', async () => {
    await t.pool.query(
      "insert into identity.permissions (key, description) values ('stale.permission', 'x')",
    );
    await t.pool.query(
      "insert into identity.role_permissions (role_id, permission_key, \"grant\") select id, 'stale.permission', 'granted' from identity.roles where key = 'viewer'",
    );
    await syncRbacCatalog(t.db);
    const left = await t.pool.query(
      "select count(*)::int c from identity.permissions where key = 'stale.permission'",
    );
    expect(left.rows[0].c).toBe(0);
  });
});

describe('first-run setup', () => {
  it('rejects weak input, then creates the organization and its administrator once', async () => {
    await expect(setupFirstAdmin(t.db, { ...ADMIN, password: 'short' })).rejects.toThrow(
      'password.too_short',
    );
    await expect(setupFirstAdmin(t.db, { ...ADMIN, email: 'nope' })).rejects.toThrow('email.invalid');
    admin = await setupFirstAdmin(t.db, ADMIN);
    await expect(setupFirstAdmin(t.db, { ...ADMIN, email: 'second@example.test' })).rejects.toThrow(
      'setup.already_done',
    );
    const users = await t.pool.query('select email, status, password_hash from identity.users');
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(users.rows[0].password_hash).not.toContain(ADMIN.password);
  });

  it('two concurrent setups create exactly one administrator', async () => {
    const other = await startTestDatabase();
    try {
      await syncRbacCatalog(other.db);
      const results = await Promise.allSettled(
        ['a@example.test', 'b@example.test'].map((email) => setupFirstAdmin(other.db, { ...ADMIN, email })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await other.pool.query('select count(*)::int c from identity.users')).rows[0].c).toBe(1);
    } finally {
      await other.stop();
    }
  });
});

describe('login and sessions', () => {
  it('logs in with the right password and resolves the session to a principal', async () => {
    const result = await loginSession(
      t.db,
      { email: 'ADMIN@example.test', password: ADMIN.password },
      { ip: '127.0.0.1' },
    );
    const principal = await resolveSession(t.db, result.token);
    expect(principal).toMatchObject({ userId: admin.userId, email: ADMIN.email });
    expect([...principal!.orgRoles].sort()).toEqual(['org_admin', 'platform_admin']);
    // Only a hash of the token is stored.
    const stored = await t.pool.query('select id from identity.sessions');
    expect(stored.rows.map((r) => r.id)).not.toContain(result.token);
    expect(csrfTokenMatches(result.token, result.csrfToken)).toBe(true);
    expect(csrfTokenMatches(result.token, csrfTokenFor('another-session-token-value'))).toBe(false);
    expect(csrfTokenMatches(result.token, undefined)).toBe(false);
  });

  it('gives the same error for a wrong password, an unknown email and an inactive user', async () => {
    await addUser('inactive@example.test', 'deactivated');
    for (const [email, password] of [
      [ADMIN.email, 'wrong password here'],
      ['nobody@example.test', ADMIN.password],
      ['inactive@example.test', 'another long password'],
      ['not-an-email', ADMIN.password],
    ] as const) {
      await expect(loginSession(t.db, { email, password }), email).rejects.toThrow(
        'auth.invalid_credentials',
      );
    }
    const failures = await t.pool.query(
      "select count(*)::int c from governance.audit_events where action = 'identity.login.failed'",
    );
    expect(failures.rows[0].c).toBe(2); // only for accounts that exist
  });

  it('issues a different token on every login and logout ends only that session', async () => {
    const a = await loginSession(t.db, { email: ADMIN.email, password: ADMIN.password });
    const b = await loginSession(t.db, { email: ADMIN.email, password: ADMIN.password });
    expect(a.token).not.toBe(b.token);
    await logout(t.db, (await resolveSession(t.db, a.token))!);
    expect(await resolveSession(t.db, a.token)).toBeNull();
    expect(await resolveSession(t.db, b.token)).not.toBeNull();
  });

  it('expires sessions on the idle and the absolute timeout', async () => {
    const policy = { idleMinutes: 30, absoluteDays: 1 };
    const idle = await loginSession(t.db, { email: ADMIN.email, password: ADMIN.password }, {}, policy);
    const later = new Date(Date.now() + 31 * 60_000);
    expect(await resolveSession(t.db, idle.token, policy, later)).toBeNull();
    expect(await resolveSession(t.db, idle.token, policy)).toBeNull(); // deleted, not just hidden

    const abs = await loginSession(t.db, { email: ADMIN.email, password: ADMIN.password }, {}, policy);
    // Kept active by regular use, but past the absolute limit.
    await t.pool.query("update identity.sessions set last_seen_at = now() + interval '25 hours'");
    expect(await resolveSession(t.db, abs.token, policy, new Date(Date.now() + 25 * 3_600_000))).toBeNull();
  });

  it('rejects garbage tokens and stops working the moment a user is deactivated (M13-AC-03)', async () => {
    for (const bad of [null, undefined, '', 'x', 'a'.repeat(500), "' or 1=1 --aaaaaaaaaaaaaaaaaaaa"]) {
      expect(await resolveSession(t.db, bad)).toBeNull();
    }
    const id = await addUser('leaver@example.test');
    const { token } = await loginSession(t.db, {
      email: 'leaver@example.test',
      password: 'another long password',
    });
    expect(await resolveSession(t.db, token)).not.toBeNull();
    await t.pool.query("update identity.users set status = 'deactivated' where id = $1", [id]);
    expect(await resolveSession(t.db, token)).toBeNull();
  });

  it('purges expired sessions', async () => {
    await loginSession(t.db, { email: ADMIN.email, password: ADMIN.password });
    await t.pool.query("update identity.sessions set expires_at = now() - interval '1 minute'");
    expect(await purgeExpiredSessions(t.db)).toBeGreaterThan(0);
    expect((await t.pool.query('select count(*)::int c from identity.sessions')).rows[0].c).toBe(0);
  });
});

describe('authorization', () => {
  it('decides org permissions from org roles and denies unknown permissions', async () => {
    const adminPrincipal = await principalOf(ADMIN.email, ADMIN.password);
    expect(await authorize(t.db, adminPrincipal, 'user.manage')).toEqual({ allowed: true, grant: 'granted' });
    expect(await authorize(t.db, adminPrincipal, 'system.settings')).toMatchObject({ allowed: true });
    expect(await authorize(t.db, adminPrincipal, 'no.such.permission')).toEqual({
      allowed: false,
      reason: 'unknown_permission',
    });
    expect(orgPermissionsOf(adminPrincipal)).toContain('connection.manage');

    await addUser('plain@example.test');
    const plain = await principalOf('plain@example.test');
    expect(await authorize(t.db, plain, 'user.manage')).toEqual({ allowed: false, reason: 'no_grant' });
    expect(orgPermissionsOf(plain)).toEqual([]);
  });

  it('scopes project permissions to the project the user is a member of (M13-AC-02)', async () => {
    const projectA = await addProject();
    const projectB = await addProject();
    const userId = await addUser('engineer@example.test');
    await addProjectMember(projectA, userId, 'qa_engineer');
    const p = await principalOf('engineer@example.test');

    expect(await authorize(t.db, p, 'testcase.create', projectA)).toMatchObject({ allowed: true });
    expect(await authorize(t.db, p, 'testcase.create', projectB)).toEqual({
      allowed: false,
      reason: 'no_grant',
    });
    expect(await authorize(t.db, p, 'project.read', projectB)).toMatchObject({ allowed: false });
    expect(await authorize(t.db, p, 'testcase.create')).toMatchObject({ allowed: false }); // no project given
    expect(await authorize(t.db, p, 'testcase.approve', projectA)).toMatchObject({ allowed: false });
    expect(await authorize(t.db, p, 'run.cancel', projectA)).toEqual({ allowed: true, grant: 'own' });
    expect(await authorize(t.db, p, 'codegen.request', projectA)).toEqual({
      allowed: false,
      reason: 'policy_required',
    });
  });

  it('org_admin can administer any project but cannot do test work without a membership', async () => {
    const project = await addProject();
    const adminPrincipal = await principalOf(ADMIN.email, ADMIN.password);
    expect(await authorize(t.db, adminPrincipal, 'project.settings.manage', project)).toMatchObject({
      allowed: true,
    });
    expect(await authorize(t.db, adminPrincipal, 'execution.run', project)).toMatchObject({ allowed: false });
    await addProjectMember(project, admin.userId, 'qa_lead');
    expect(await authorize(t.db, adminPrincipal, 'execution.run', project)).toMatchObject({ allowed: true });
  });
});
