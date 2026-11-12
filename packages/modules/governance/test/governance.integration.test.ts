import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import {
  hashPassword,
  login,
  resolveSession,
  setupFirstAdmin,
  syncRbacCatalog,
  type Principal,
  type RoleKey,
} from '@qos/identity';
import { uuidv7 } from '@qos/kernel-domain';
import {
  decide,
  getPreferences,
  getPolicy,
  invalidateApprovals,
  listNotifications,
  markRead,
  myApprovals,
  notify,
  requestApproval,
  setPolicy,
  setPreferences,
} from '../src/index.js';

const PW = 'a long enough password';
let t: TestDatabase;
let orgId: string;
let admin: Principal;
let seq = 0;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

async function user(email: string): Promise<Principal> {
  const id = uuidv7();
  await t.pool.query(
    `insert into identity.users (id, org_id, email, display_name, password_hash, status, created_at)
     values ($1, $2, $3, $4, $5, 'active', now())`,
    [id, orgId, email, email, await hashPassword(PW)],
  );
  const { token } = await login(t.db, { email, password: PW });
  return (await resolveSession(t.db, token))!;
}
async function project(members: [Principal, RoleKey][]): Promise<string> {
  const id = uuidv7();
  await t.pool.query(
    `insert into projects.projects (id, org_id, key, name, status, created_by, created_at, updated_at)
     values ($1, $2, $3, 'P', 'active', $4, now(), now())`,
    [id, orgId, `G${++seq}`, admin.userId],
  );
  for (const [p, role] of members) {
    await t.pool.query(
      'insert into identity.project_memberships (project_id, user_id, role_id) select $1, $2, id from identity.roles where key = $3',
      [id, p.userId, role],
    );
  }
  return id;
}
const request = (actor: Principal, projectId: string, content = 'v1', targetId = 'tc-1') =>
  t.db.transaction((tx) =>
    requestApproval(tx, actor, {
      projectId,
      action: 'testcase.approve',
      targetType: 'test_case',
      targetId,
      contentHash: hash(content),
    }),
  );

beforeAll(async () => {
  t = await startTestDatabase();
  await syncRbacCatalog(t.db);
  ({ orgId } = await setupFirstAdmin(t.db, {
    orgName: 'Gov Org',
    email: 'admin@example.test',
    displayName: 'A',
    password: PW,
  }));
  const { token } = await login(t.db, { email: 'admin@example.test', password: PW });
  admin = (await resolveSession(t.db, token))!;
}, 180_000);
afterAll(async () => {
  await t?.stop();
});

describe('approval engine (M14-FR-04/05)', () => {
  it('the author cannot approve their own draft under the default policy (M14-AC-03)', async () => {
    const author = await user('author@example.test');
    const reviewer = await user('reviewer@example.test');
    const pid = await project([
      [author, 'qa_lead'],
      [reviewer, 'qc_reviewer'],
    ]);
    const req = await request(author, pid);
    expect(req).toMatchObject({ status: 'pending', approvalsRequired: 1, approvals: 0 });
    await expect(decide(t.db, author, { requestId: req.id, decision: 'approve' })).rejects.toThrow(
      'approval.separation_of_duties',
    );
    expect((await myApprovals(t.db, author)).map((r) => r.id)).not.toContain(req.id);
    expect((await myApprovals(t.db, reviewer)).map((r) => r.id)).toContain(req.id);
    const done = await decide(t.db, reviewer, { requestId: req.id, decision: 'approve', comment: 'ok' });
    expect(done).toMatchObject({ status: 'approved', approvals: 1 });
    await expect(decide(t.db, reviewer, { requestId: req.id, decision: 'approve' })).rejects.toThrow(
      'approval.not_pending',
    );
    // The requester was told, and the approver got the request in the app.
    expect((await listNotifications(t.db, author.userId)).items.map((n) => n.type)).toContain(
      'approval.decided',
    );
    expect((await listNotifications(t.db, reviewer.userId)).items.map((n) => n.type)).toContain(
      'approval.requested',
    );
  });

  it('self-approval works only in a single-approver project, and is flagged', async () => {
    const solo = await user('solo@example.test');
    const pid = await project([[solo, 'qa_lead']]);
    await setPolicy(t.db, admin, pid, 'testcase.approve', {
      approverRoles: ['qa_lead'],
      approvalsRequired: 1,
      allowSelfApproval: true,
      expiresInHours: 24,
    });
    const req = await request(solo, pid);
    expect(await decide(t.db, solo, { requestId: req.id, decision: 'approve' })).toMatchObject({
      status: 'approved',
    });
    const flagged = await t.pool.query(
      'select self_approval from governance.approval_decisions where request_id = $1',
      [req.id],
    );
    expect(flagged.rows[0].self_approval).toBe(true);
    const audit = await t.pool.query(
      "select summary from governance.audit_events where action = 'approval.approved' and summary->>'requestId' = $1",
      [req.id],
    );
    expect(audit.rows[0].summary.selfApproval).toBe(true);

    // A second approver joins: the override no longer applies.
    const second = await user('second-lead@example.test');
    await t.pool.query(
      "insert into identity.project_memberships (project_id, user_id, role_id) select $1, $2, id from identity.roles where key = 'qa_lead'",
      [pid, second.userId],
    );
    const next = await request(solo, pid, 'v2', 'tc-2');
    await expect(decide(t.db, solo, { requestId: next.id, decision: 'approve' })).rejects.toThrow(
      'approval.separation_of_duties',
    );
  });

  it('editing the content invalidates the pending approval (M14-AC-04)', async () => {
    const author = await user('author2@example.test');
    const reviewer = await user('reviewer2@example.test');
    const pid = await project([
      [author, 'qa_engineer'],
      [reviewer, 'qa_lead'],
    ]);
    const first = await request(author, pid, 'draft v1');
    expect((await request(author, pid, 'draft v1')).id).toBe(first.id); // same content: same request
    const n = await t.db.transaction((tx) =>
      invalidateApprovals(tx, pid, 'test_case', 'tc-1', hash('draft v2')),
    );
    expect(n).toBe(1);
    await expect(decide(t.db, reviewer, { requestId: first.id, decision: 'approve' })).rejects.toThrow(
      'approval.not_pending',
    );
    // Requesting again with new content replaces any pending request for the old content.
    const second = await request(author, pid, 'draft v2');
    const third = await request(author, pid, 'draft v3');
    expect(third.id).not.toBe(second.id);
    const statuses = await t.pool.query(
      'select status from governance.approval_requests where id = any($1)',
      [[second.id, third.id]],
    );
    expect(statuses.rows.map((r) => r.status).sort()).toEqual(['invalidated', 'pending']);
  });

  it('needs N approvals, executes exactly once under concurrent approvals, and a reject ends it', async () => {
    const author = await user('author3@example.test');
    const reviewers = await Promise.all([1, 2, 3].map((i) => user(`rev3-${i}@example.test`)));
    const pid = await project([
      [author, 'qa_engineer'],
      ...reviewers.map((r) => [r, 'qa_lead'] as [Principal, RoleKey]),
    ]);
    await setPolicy(t.db, admin, pid, 'testcase.approve', {
      approverRoles: ['qa_lead'],
      approvalsRequired: 2,
      allowSelfApproval: false,
      expiresInHours: 24,
    });
    const req = await request(author, pid);
    const results = await Promise.allSettled(
      reviewers.map((r) => decide(t.db, r, { requestId: req.id, decision: 'approve' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const events = await t.pool.query(
      "select count(*)::int c from platform.outbox_events where type = 'approval.decided' and aggregate_id = $1",
      [req.id],
    );
    expect(events.rows[0].c).toBe(1);

    const rej = await request(author, pid, 'other', 'tc-9');
    expect(await decide(t.db, reviewers[0]!, { requestId: rej.id, decision: 'reject' })).toMatchObject({
      status: 'rejected',
    });
  });

  it('refuses ineligible roles, outsiders and expired requests; policy edits do not touch pending requests', async () => {
    const author = await user('author4@example.test');
    const viewer = await user('viewer4@example.test');
    const outsider = await user('outsider4@example.test');
    const lead = await user('lead4@example.test');
    const pid = await project([
      [author, 'qa_engineer'],
      [viewer, 'viewer'],
      [lead, 'qa_lead'],
    ]);
    const req = await request(author, pid);
    await expect(decide(t.db, viewer, { requestId: req.id, decision: 'approve' })).rejects.toThrow(
      'approval.not_eligible',
    );
    await expect(decide(t.db, outsider, { requestId: req.id, decision: 'approve' })).rejects.toThrow(
      'approval.not_found',
    );
    // Raising the bar afterwards does not change the open request (snapshot of rules).
    await setPolicy(t.db, admin, pid, 'testcase.approve', {
      approverRoles: ['qa_lead'],
      approvalsRequired: 3,
      allowSelfApproval: false,
      expiresInHours: 24,
    });
    expect(await decide(t.db, lead, { requestId: req.id, decision: 'approve' })).toMatchObject({
      status: 'approved',
    });

    const late = await request(author, pid, 'x', 'tc-late');
    await t.pool.query(
      "update governance.approval_requests set expires_at = now() - interval '1 minute' where id = $1",
      [late.id],
    );
    await expect(decide(t.db, lead, { requestId: late.id, decision: 'approve' })).rejects.toThrow(
      'approval.not_pending',
    );
    expect(
      (await t.pool.query('select status from governance.approval_requests where id = $1', [late.id])).rows[0]
        .status,
    ).toBe('expired');
  });

  it('validates rules and versions policies', async () => {
    const pid = await project([]);
    expect(await getPolicy(t.db, pid, 'run.production')).toMatchObject({ isDefault: true, version: 0 });
    for (const bad of [
      { approverRoles: [], approvalsRequired: 1, expiresInHours: 1 },
      { approverRoles: ['wizard'], approvalsRequired: 1, expiresInHours: 1 },
      { approverRoles: ['qa_lead'], approvalsRequired: 0, expiresInHours: 1 },
      { approverRoles: ['qa_lead'], approvalsRequired: 1, expiresInHours: 99999 },
    ]) {
      await expect(setPolicy(t.db, admin, pid, 'run.production', bad)).rejects.toThrow(
        'approval.rules_invalid',
      );
    }
    const v1 = await setPolicy(t.db, admin, pid, 'run.production', {
      approverRoles: ['qa_lead'],
      approvalsRequired: 2,
      expiresInHours: 2,
    });
    const v2 = await setPolicy(t.db, admin, pid, 'run.production', {
      approverRoles: ['qa_lead'],
      approvalsRequired: 1,
      expiresInHours: 2,
    });
    expect([v1.version, v2.version]).toEqual([1, 2]);
  });
});

describe('notifications (M14-FR, T-P2-54)', () => {
  it('stores once per dedupe key, respects preferences, and marks only own items read', async () => {
    const u = await user('notif@example.test');
    const other = await user('notif-other@example.test');
    const n = {
      userId: u.userId,
      type: 'connection.credential.expiring' as const,
      payload: { connectionId: 'c' },
      dedupeKey: 'k1',
    };
    expect(await notify(t.db, n)).toBe(true);
    expect(await notify(t.db, n)).toBe(false);
    const list = await listNotifications(t.db, u.userId);
    expect(list).toMatchObject({ unread: 1 });
    expect(await markRead(t.db, other.userId, [list.items[0]!.id])).toBe(0);
    expect(await markRead(t.db, u.userId, [list.items[0]!.id])).toBe(1);
    expect((await listNotifications(t.db, u.userId)).unread).toBe(0);

    expect((await getPreferences(t.db, u.userId))['connection.credential.expiring']).toBe(true);
    await setPreferences(t.db, u.userId, { 'connection.credential.expiring': false });
    expect(await notify(t.db, { ...n, dedupeKey: 'k2' })).toBe(false);
    await expect(setPreferences(t.db, u.userId, { 'made.up': true })).rejects.toThrow(
      'notification.type_unknown',
    );
  });
});

describe('credential expiry check (T-P2-31, M03-AC-07)', () => {
  it('warns each org admin once per day window, with one audit entry per day', async () => {
    const { DbEnvelopeSecretStore, generateMasterKey, parseMasterKey } =
      await import('@qos/adapters-secrets-db');
    const { MockRepositoryProvider } = await import('@qos/adapters-mock');
    const { createConnection, ProviderRegistry, testConnection } = await import('@qos/integrations');
    const { createLogger } = await import('@qos/observability');
    const { checkCredentialExpiry } = await import('../src/index.js');
    const deps = {
      db: t.db,
      registry: new ProviderRegistry().register(new MockRepositoryProvider()),
      secrets: new DbEnvelopeSecretStore(t.db, parseMasterKey(generateMasterKey())),
      http: { request: async () => Promise.reject(new Error('no network')) },
      logger: createLogger({ service: 'test', level: 'silent' }),
    };
    const now = new Date('2026-11-12T08:00:00Z');
    const actor = { orgId, userId: admin.userId };
    const soon = await createConnection(deps, actor, {
      providerType: 'mock_repository',
      displayName: 'Expiring PAT',
      authStrategy: 'pat',
      credential: 'mock-token;expires=2026-11-22', // 10 days ahead
    });
    const later = await createConnection(deps, actor, {
      providerType: 'mock_repository',
      displayName: 'Long-lived PAT',
      authStrategy: 'pat',
      credential: 'mock-token;expires=2027-06-01',
    });
    await testConnection(deps, actor, soon.id);
    await testConnection(deps, actor, later.id);

    const count = async (sql: string) => (await t.pool.query(sql)).rows[0].c as number;
    const warnings = () =>
      count(
        `select count(*)::int c from governance.notifications
         where type = 'connection.credential.expiring' and payload->>'connectionId' = '${soon.id}'`,
      );
    const audits = () =>
      count(
        "select count(*)::int c from governance.audit_events where action = 'connection.credential.expiring'",
      );

    expect(await checkCredentialExpiry(t.db, now)).toEqual({ warned: 1 }); // one org admin
    expect(await checkCredentialExpiry(t.db, new Date('2026-11-12T20:00:00Z'))).toEqual({ warned: 0 }); // same day
    expect([await warnings(), await audits()]).toEqual([1, 1]);
    const [n] = (await listNotifications(t.db, admin.userId)).items.filter(
      (x) => x.type === 'connection.credential.expiring',
    );
    expect(n!.payload).toMatchObject({ connectionId: soon.id, daysLeft: 10 });

    expect(await checkCredentialExpiry(t.db, new Date('2026-11-13T08:00:00Z'))).toEqual({ warned: 1 }); // next day
    expect([await warnings(), await audits()]).toEqual([2, 2]);
  });
});
