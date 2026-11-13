import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { requestApproval } from '@qos/governance';
import { hashPassword, login, resolveSession } from '@qos/identity';
import { uuidv7 } from '@qos/kernel-domain';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { AUTH_ENV, setupAndSignIn, signIn, type Session } from './helpers.js';

const PW = 'a long enough password';
let t: TestDatabase;
let api: ApiApp;
let base: string;
let admin: Session;
let author: { id: string; session: Session };
let reviewer: { id: string; session: Session };

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const code = async (res: Response) => ApiError.parse(await res.json()).code;
async function addUser(email: string) {
  const id = uuidv7();
  const org = (await t.pool.query('select id from identity.organizations')).rows[0].id;
  await t.pool.query(
    `insert into identity.users (id, org_id, email, display_name, password_hash, status, created_at)
     values ($1, $2, $3, $4, $5, 'active', now())`,
    [id, org, email, email, await hashPassword(PW)],
  );
  return { id, session: await signIn(base, email, PW) };
}

beforeAll(async () => {
  t = await startTestDatabase();
  api = await createApiApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_PORT: '0',
    RATE_LIMIT_BURST: '5000',
    RATE_LIMIT_RPS: '5000',
    ...AUTH_ENV,
  });
  base = await api.listen();
  admin = await setupAndSignIn(base);
  await admin.fetch(`${base}/api/v1/projects`, send('POST', { key: 'GOV', name: 'Governance' }));
  author = await addUser('author@example.test');
  reviewer = await addUser('reviewer@example.test');
  await admin.fetch(`${base}/api/v1/projects/GOV/members/${author.id}`, send('PUT', { role: 'qa_engineer' }));
  await admin.fetch(
    `${base}/api/v1/projects/GOV/members/${reviewer.id}`,
    send('PUT', { role: 'qc_reviewer' }),
  );
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
});

/** Opens a request as the author, the way a module action will once test cases exist (P4). */
async function openRequest(content: string) {
  const result = await login(t.db, { email: 'author@example.test', password: PW });
  if (result.kind !== 'session') throw new Error('unexpected MFA challenge');
  const { token } = result;
  const principal = (await resolveSession(t.db, token))!;
  const projectId = (await t.pool.query("select id from projects.projects where key = 'GOV'")).rows[0].id;
  return t.db.transaction((tx) =>
    requestApproval(tx, principal, {
      projectId,
      action: 'testcase.approve',
      targetType: 'test_case',
      targetId: 'GOV-TC-1',
      contentHash: createHash('sha256').update(content).digest('hex'),
    }),
  );
}

describe('approvals over HTTP', () => {
  it('lists the request for the reviewer only; the author cannot decide it', async () => {
    const req = await openRequest('v1');
    const forReviewer = (await (await reviewer.session.fetch(`${base}/api/v1/me/approvals`)).json()) as {
      id: string;
    }[];
    expect(forReviewer.map((r) => r.id)).toEqual([req.id]);
    expect(await (await author.session.fetch(`${base}/api/v1/me/approvals`)).json()).toEqual([]);

    const self = await author.session.fetch(`${base}/api/v1/approvals/${req.id}/approve`, send('POST', {}));
    expect(self.status).toBe(403);
    // The author is a qa_engineer, not an approver role; separation of duties is covered in the module tests.
    expect(await code(self)).toBe('approval.not_eligible');

    const ok = await reviewer.session.fetch(
      `${base}/api/v1/approvals/${req.id}/approve`,
      send('POST', { comment: 'fine' }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'approved', approvals: 1 });
    const again = await reviewer.session.fetch(`${base}/api/v1/approvals/${req.id}/reject`, send('POST', {}));
    expect(again.status).toBe(409);
    expect((await admin.fetch(`${base}/api/v1/approvals/${uuidv7()}/approve`, send('POST', {}))).status).toBe(
      404,
    );
  });

  it('notifies both sides and lets each mark their own notifications read', async () => {
    const mine = (await (await reviewer.session.fetch(`${base}/api/v1/me/notifications`)).json()) as {
      items: { id: string; type: string }[];
      unread: number;
    };
    expect(mine.items.map((n) => n.type)).toContain('approval.requested');
    expect(mine.unread).toBeGreaterThan(0);
    const marked = await reviewer.session.fetch(
      `${base}/api/v1/me/notifications/mark-read`,
      send('POST', {}),
    );
    expect(await marked.json()).toEqual({ marked: mine.unread });
    const authorView = (await (
      await author.session.fetch(`${base}/api/v1/me/notifications?unread=true`)
    ).json()) as {
      items: { type: string }[];
    };
    expect(authorView.items.map((n) => n.type)).toContain('approval.decided');
  });

  it('serves and updates notification preferences', async () => {
    const prefs = await (await author.session.fetch(`${base}/api/v1/me/notification-preferences`)).json();
    expect(prefs).toMatchObject({ 'approval.requested': true });
    const updated = await author.session.fetch(
      `${base}/api/v1/me/notification-preferences`,
      send('PUT', { 'approval.decided': false }),
    );
    expect(await updated.json()).toMatchObject({ 'approval.decided': false });
    expect(
      (await author.session.fetch(`${base}/api/v1/me/notification-preferences`, send('PUT', { nope: true })))
        .status,
    ).toBe(422);
  });
});

describe('approval policies', () => {
  it('lists defaults, lets a lead or admin change them, and refuses others', async () => {
    const list = (await (
      await author.session.fetch(`${base}/api/v1/projects/GOV/approval-policies`)
    ).json()) as {
      action: string;
      isDefault: boolean;
    }[];
    expect(list).toHaveLength(8);
    expect(list.every((p) => p.isDefault)).toBe(true);
    const rules = {
      approverRoles: ['qa_lead'],
      approvalsRequired: 2,
      allowSelfApproval: false,
      expiresInHours: 24,
    };
    const set = await admin.fetch(
      `${base}/api/v1/projects/GOV/approval-policies/testcase.approve`,
      send('PUT', rules),
    );
    expect(await set.json()).toMatchObject({ version: 1, rules: { approvalsRequired: 2 } });
    expect(
      (
        await author.session.fetch(
          `${base}/api/v1/projects/GOV/approval-policies/testcase.approve`,
          send('PUT', rules),
        )
      ).status,
    ).toBe(403);
    expect(
      (await admin.fetch(`${base}/api/v1/projects/GOV/approval-policies/teleport`, send('PUT', rules)))
        .status,
    ).toBe(404);
    const bad = await admin.fetch(
      `${base}/api/v1/projects/GOV/approval-policies/testcase.approve`,
      send('PUT', { ...rules, approvalsRequired: 0 }),
    );
    expect(await code(bad)).toBe('approval.rules_invalid');
  });
});
