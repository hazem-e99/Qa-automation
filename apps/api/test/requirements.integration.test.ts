import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { hashPassword } from '@qos/identity';
import { uuidv7 } from '@qos/kernel-domain';
import { onApprovalDecided } from '@qos/requirements';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { AUTH_ENV, setupAndSignIn, signIn, type Session } from './helpers.js';

let t: TestDatabase;
let api: ApiApp;
let base: string;
let author: Session; // org admin, creator and QA lead of the project
let reviewer: Session; // second QA lead: approves (separation of duties)
let viewer: Session;

type Version = {
  number: number;
  state: string;
  title: string;
  acceptanceCriteria: { text: string; origin: string }[];
  approvalRequestId: string | null;
};
type Detail = {
  key: string;
  state: string;
  effectiveVersion: number | null;
  latestVersion: number;
  sourceKinds: string[];
  openFindings: number;
  versions: Version[];
  provenance: { sourceKind: string; method: string; locator: Record<string, unknown> }[];
};
const V = (p: string) => `${base}/api/v1/projects/REQ${p}`;
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const json = async <T>(res: Response): Promise<T> => {
  if (res.status >= 300) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};
const code = async (res: Response) => ApiError.parse(await res.json()).code;
const create = (s: Session, title: string, extra: Record<string, unknown> = {}) =>
  json<Detail>(
    s.fetch(V('/requirements'), send('POST', { title, bodyMd: 'Body', ...extra })) as unknown as Response,
  ).catch(() => null);

async function addUser(email: string, role: string): Promise<Session> {
  const id = uuidv7();
  const org = (await t.pool.query('select id from identity.organizations')).rows[0].id;
  await t.pool.query(
    `insert into identity.users (id, org_id, email, display_name, password_hash, status, created_at) values ($1, $2, $3, $5, $4, 'active', now())`,
    [id, org, email, await hashPassword('requirements test password'), email],
  );
  expect((await author.fetch(V(`/members/${id}`), send('PUT', { role }))).status).toBe(200);
  return signIn(base, email, 'requirements test password');
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
  author = await setupAndSignIn(base);
  await json(
    await author.fetch(`${base}/api/v1/projects`, send('POST', { key: 'REQ', name: 'Requirements' })),
  );
  reviewer = await addUser('reviewer@example.test', 'qa_lead');
  viewer = await addUser('viewer@example.test', 'viewer');
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
});

describe('requirements: manual entry, versions and search (T-P3-01/03/13)', () => {
  it('creates PRJ-R-1 as a draft with manual provenance', async () => {
    const r = await json<Detail>(
      await author.fetch(
        V('/requirements'),
        send('POST', {
          title: 'تسجيلُ الدُّخولِ إلى النظام',
          bodyMd: 'يجب أن يتمكن المستخدم من الدخول بالبريد الإلكتروني.',
          priority: 'high',
          tags: ['Auth'],
          acceptanceCriteria: [{ text: 'Valid credentials open the dashboard' }],
        }),
      ),
    );
    expect(r).toMatchObject({
      key: 'REQ-R-1',
      state: 'draft',
      latestVersion: 1,
      effectiveVersion: null,
      sourceKinds: ['manual'],
    });
    expect(r.provenance).toEqual([expect.objectContaining({ sourceKind: 'manual', method: 'manual' })]);
    const sources = await json<{ kind: string; name: string }[]>(
      await author.fetch(V('/requirement-sources')),
    );
    expect(sources).toEqual([expect.objectContaining({ kind: 'manual', name: 'Manual entries' })]);
  });

  it('finds Arabic text regardless of diacritics and letter variants (M04-AC-06, search part)', async () => {
    for (const q of ['الدخول', 'الدُّخول', 'النظام', 'dashboard']) {
      const list = await json<{ key: string }[]>(
        await author.fetch(V(`/requirements?q=${encodeURIComponent(q)}`)),
      );
      expect(
        list.map((x) => x.key),
        q,
      ).toEqual(['REQ-R-1']);
    }
    expect(
      await json<unknown[]>(await author.fetch(V(`/requirements?q=${encodeURIComponent('الخروج')}`))),
    ).toEqual([]);
  });

  it('every edit is a new version; stale edits are refused', async () => {
    const r = await json<Detail>(
      await author.fetch(
        V('/requirements/REQ-R-1'),
        send('PUT', { title: 'تسجيل الدخول إلى النظام', bodyMd: 'v2', expectedLatestVersion: 1 }),
      ),
    );
    expect(r.versions.map((v) => [v.number, v.state])).toEqual([
      [2, 'draft'],
      [1, 'superseded'],
    ]);
    const stale = await author.fetch(
      V('/requirements/REQ-R-1'),
      send('PUT', { title: 'x title', expectedLatestVersion: 1 }),
    );
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe('requirement.version_conflict');
  });

  it('versions and criteria are immutable in the database (BR-M04-2)', async () => {
    await expect(
      t.pool.query(`update requirements.requirement_versions set title = 'tampered'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(t.pool.query(`delete from requirements.requirement_versions`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      t.pool.query(`update requirements.acceptance_criteria set text = 'x'`),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('approval workflow (T-P3-09)', () => {
  it('submit → review → approve; the author cannot approve their own requirement', async () => {
    const s = await json<Detail>(await author.fetch(V('/requirements/REQ-R-1/submit'), send('POST')));
    expect(s.state).toBe('in_review');
    expect(
      await code(
        await author.fetch(
          V('/requirements/REQ-R-1'),
          send('PUT', { title: 'during review', expectedLatestVersion: 2 }),
        ),
      ),
    ).toBe('requirement.in_review');
    const own = await author.fetch(
      V('/requirements/REQ-R-1/decision'),
      send('POST', { decision: 'approve' }),
    );
    expect(await code(own)).toBe('approval.separation_of_duties');
    const ok = await json<Detail>(
      await reviewer.fetch(V('/requirements/REQ-R-1/decision'), send('POST', { decision: 'approve' })),
    );
    expect(ok).toMatchObject({ state: 'approved', effectiveVersion: 2 });
  });

  it('a new edit is a draft; the approved version stays effective (M04-FR-11)', async () => {
    const r = await json<Detail>(
      await author.fetch(
        V('/requirements/REQ-R-1'),
        send('PUT', { title: 'تسجيل الدخول v3', bodyMd: 'v3', expectedLatestVersion: 2 }),
      ),
    );
    expect(r).toMatchObject({ state: 'draft', latestVersion: 3, effectiveVersion: 2 });
    expect(r.versions.find((v) => v.number === 2)!.state).toBe('approved');
  });

  it('decisions from the generic approvals inbox are applied through the outbox event', async () => {
    await json(await author.fetch(V('/requirements/REQ-R-1/submit'), send('POST')));
    const d = await json<Detail>(await author.fetch(V('/requirements/REQ-R-1')));
    const requestId = d.versions[0]!.approvalRequestId!;
    await json(await reviewer.fetch(`${base}/api/v1/approvals/${requestId}/approve`, send('POST', {})));
    const ev = (
      await t.pool.query(
        `select * from platform.outbox_events where type = 'approval.decided' order by occurred_at desc limit 1`,
      )
    ).rows[0];
    const event = {
      eventId: ev.id,
      type: ev.type,
      aggregateType: ev.aggregate_type,
      aggregateId: ev.aggregate_id,
      projectId: ev.project_id,
      occurredAt: ev.occurred_at,
      correlationId: ev.correlation_id,
      payload: ev.payload,
    };
    await t.db.transaction((tx) => onApprovalDecided(event as never, tx));
    await t.db.transaction((tx) => onApprovalDecided(event as never, tx)); // idempotent
    const after = await json<Detail>(await author.fetch(V('/requirements/REQ-R-1')));
    expect(after).toMatchObject({ state: 'approved', effectiveVersion: 3 });
    expect(after.versions.find((v) => v.number === 2)!.state).toBe('superseded');
  });
});

describe('conflicts block approval (M04-AC-05) and inferred criteria need confirmation (M04-AC-02)', () => {
  it('a conflict sends the other requirement back to draft and blocks submission until waived', async () => {
    await json(
      await author.fetch(V('/requirements'), send('POST', { title: 'Session timeout is 30 minutes' })),
    );
    await json(await author.fetch(V('/requirements/REQ-R-2/submit'), send('POST')));
    const finding = await json<{ id: string }>(
      await author.fetch(
        V('/requirement-findings'),
        send('POST', { keys: ['REQ-R-1', 'REQ-R-2'], note: 'R-1 says 15 minutes' }),
      ),
    );
    expect((await json<Detail>(await author.fetch(V('/requirements/REQ-R-2')))).state).toBe('draft');
    const blocked = await author.fetch(V('/requirements/REQ-R-2/submit'), send('POST'));
    expect(await code(blocked)).toBe('requirement.open_conflict');
    // Waiving needs finding.waive (qa_lead); a viewer cannot.
    expect(
      (
        await viewer.fetch(
          V(`/requirement-findings/${finding.id}/close`),
          send('POST', { status: 'waived', reason: 'not related' }),
        )
      ).status,
    ).toBe(403);
    await json(
      await reviewer.fetch(
        V(`/requirement-findings/${finding.id}/close`),
        send('POST', { status: 'waived', reason: 'Different contexts' }),
      ),
    );
    expect(
      (await json<Detail>(await author.fetch(V('/requirements/REQ-R-2/submit'), send('POST')))).state,
    ).toBe('in_review');
  });

  it('bulk approval refuses inferred criteria without the confirmation and records it', async () => {
    await json(
      await author.fetch(
        V('/requirements'),
        send('POST', {
          title: 'Password must be strong',
          acceptanceCriteria: [
            { text: 'At least 12 characters' },
            { text: 'Rejects common passwords', origin: 'inferred' },
          ],
        }),
      ),
    );
    await json(await author.fetch(V('/requirements/REQ-R-3/submit'), send('POST')));
    const refused = await reviewer.fetch(
      V('/requirements/bulk-approve'),
      send('POST', { keys: ['REQ-R-2', 'REQ-R-3'] }),
    );
    expect(ApiError.parse(await refused.json())).toMatchObject({
      code: 'requirement.inferred_confirmation_required',
      params: { keys: 'REQ-R-3' },
    });
    const ok = await json<{ approved: string[] }>(
      await reviewer.fetch(
        V('/requirements/bulk-approve'),
        send('POST', { keys: ['REQ-R-2', 'REQ-R-3'], includesInferred: true }),
      ),
    );
    expect(ok.approved.sort()).toEqual(['REQ-R-2', 'REQ-R-3']);
    const audit = await t.pool.query(
      `select summary from governance.audit_events where action = 'requirement.bulk_approved'`,
    );
    expect(audit.rows[0].summary).toMatchObject({ includesInferred: true, inferredItems: ['REQ-R-3'] });
  });
});

describe('lifecycle and permissions', () => {
  it('obsolete needs a reason and ends every open version', async () => {
    expect(
      (await author.fetch(V('/requirements/REQ-R-2/obsolete'), send('POST', { reason: '' }))).status,
    ).toBe(422);
    const r = await json<Detail>(
      await author.fetch(
        V('/requirements/REQ-R-2/obsolete'),
        send('POST', { reason: 'Replaced by REQ-R-1' }),
      ),
    );
    expect(r.versions.every((v) => v.state === 'obsolete')).toBe(true);
  });

  it('viewers read but cannot write; unknown keys are 404', async () => {
    expect((await viewer.fetch(V('/requirements'))).status).toBe(200);
    expect((await viewer.fetch(V('/requirements'), send('POST', { title: 'Nope nope' }))).status).toBe(403);
    expect((await author.fetch(V('/requirements/REQ-R-99'))).status).toBe(404);
    expect((await author.fetch(V('/requirements/not-a-key'))).status).toBe(404);
  });

  it('sources: create, rename, unique names, azure needs a binding', async () => {
    const s = await json<{ id: string }>(
      await author.fetch(V('/requirement-sources'), send('POST', { kind: 'document_set', name: 'Specs' })),
    );
    expect(
      (await author.fetch(V('/requirement-sources'), send('POST', { kind: 'document_set', name: 'Specs' })))
        .status,
    ).toBe(409);
    expect(
      await code(
        await author.fetch(V('/requirement-sources'), send('POST', { kind: 'external', name: 'Boards' })),
      ),
    ).toBe('requirement_source.binding_required');
    const renamed = await json<{ name: string }>(
      await author.fetch(V(`/requirement-sources/${s.id}`), send('PATCH', { name: 'Specifications' })),
    );
    expect(renamed.name).toBe('Specifications');
  });
});

void create;
