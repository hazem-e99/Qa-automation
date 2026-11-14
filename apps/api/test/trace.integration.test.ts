import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { hashPassword } from '@qos/identity';
import { uuidv7 } from '@qos/kernel-domain';
import type { DocumentParser, ParsedDocument } from '@qos/ports';
import { processParseJob, validateUpload } from '@qos/requirements';
import { createLink } from '@qos/traceability';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { AUTH_ENV, setupAndSignIn, signIn, type Session } from './helpers.js';

/**
 * Document changes and impact (T-P3-11, M04-AC-04), merge of duplicates (M04-AC-10), the
 * traceability base and trace view (T-P3-12), and the export (T-P3-16). Version 2 of the library
 * PDF is the real parser output of version 1 with one requirement changed, one removed and one
 * added. Test cases arrive with P4: their `verifies` links are written here through the
 * traceability module, as test management will.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CORPUS = path.join(ROOT, 'spikes/parser/corpus/files');
const PARSED = path.join(ROOT, 'packages/modules/requirements/test/fixtures/parsed');

const v1 = JSON.parse(
  readFileSync(path.join(PARSED, 'p09-library-en-numbered.json'), 'utf8'),
) as ParsedDocument;
const v2: ParsedDocument = {
  ...v1,
  blocks: v1.blocks.map((b) =>
    b.id !== 'b4'
      ? b
      : {
          ...b,
          text: b.text
            .replace('borrow up to 5 items', 'borrow up to 7 items')
            .replace(
              "Borrowing a 6th item shows 'Borrowing limit reached'.",
              "Borrowing an 8th item shows 'Borrowing limit reached'.",
            )
            .replace(
              /REQ-4: The system shall send a reminder 2 days before the due date\. Acceptance criteria: · The reminder is sent by email at 09:00 local time\. /,
              '',
            )
            .concat(
              ' REQ-6: The system shall let members pay their library fines online. Acceptance criteria: · Paying online clears the fine at once.',
            ),
        },
  ),
};
const docs: Record<string, ParsedDocument> = { 'library-v1.pdf': v1, 'library-v2.pdf': v2 };

let t: TestDatabase;
let api: ApiApp;
let base: string;
let dir: string;
let lead: Session;
let reviewer: Session;
let viewer: Session;
let sourceId: string;
let projectId: string;

const parser: DocumentParser = {
  async parse(input) {
    const doc = docs[input.fileName];
    if (!doc) throw new Error(`no fixture for ${input.fileName}`);
    return structuredClone(doc);
  },
};

const V = (p: string) => `${base}/api/v1/projects/TRC${p}`;
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

type Candidate = {
  id: string;
  text: string;
  externalKey: string | null;
  status: string;
  acceptanceCriteria: { id: string; text: string }[];
  duplicates: { key: string; similarity: number }[];
};
type Item = { itemId: string; externalKey: string | null; requirement: { key: string } | null };
type Changes = {
  previousSnapshotId: string;
  added: Item[];
  removed: Item[];
  changed: { before: Item; after: Item; fields: string[]; ac: { added: string[]; removed: string[] } }[];
  unchanged: { before: Item; after: Item }[];
  impact: {
    requirements: { key: string; change: string }[];
    testCases: { testCaseId: string; requirementKey: string; needsReview: boolean }[];
  };
};
type Detail = {
  key: string;
  state: string;
  effectiveVersion: number | null;
  latestVersion: number;
  sourceKinds: string[];
  sourceRemoved: boolean;
  versions: { number: number; state: string; acceptanceCriteria: { text: string }[] }[];
  provenance: { snapshotId: string; sourceKind: string }[];
};
type Trace = {
  coverage: string;
  parents: { key: string; linkId: string }[];
  children: { key: string }[];
  related: { key: string; linkId: string }[];
  verifiedBy: {
    linkId: string;
    testCaseId: string;
    needsReview: boolean;
    reviewReason: { kind: string } | null;
  }[];
};

async function uploadAndParse(file: string, bytesOf: string): Promise<string> {
  const res = await lead.fetch(
    V(
      `/requirement-sources/${sourceId}/documents?fileName=${file}&title=${encodeURIComponent('Library rules')}`,
    ),
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: readFileSync(path.join(CORPUS, bytesOf)),
    },
  );
  const up = await json<{ snapshotId: string }>(res);
  const deps = { db: api.infra.db, storage: api.storage, jobs: api.infra.jobs, parser };
  expect(await processParseJob(deps, { projectId, snapshotId: up.snapshotId })).toMatchObject({
    status: 'parsed',
  });
  return up.snapshotId;
}
const candidates = (snapshotId: string, status = 'candidate') =>
  lead.fetch(V(`/snapshots/${snapshotId}/candidates?status=${status}`)).then((r) => json<Candidate[]>(r));
const detail = (key: string) => lead.fetch(V(`/requirements/${key}`)).then((r) => json<Detail>(r));
const trace = (key: string) => lead.fetch(V(`/requirements/${key}/trace`)).then((r) => json<Trace>(r));
const project = () => ({ id: projectId });

let snap1: string;
let snap2: string;
const keyOf: Record<string, string> = {};
const testCase = { r1: uuidv7(), r4: uuidv7(), r2: uuidv7() };

async function addUser(email: string, role: string): Promise<Session> {
  const id = uuidv7();
  const org = (await t.pool.query('select id from identity.organizations')).rows[0].id;
  await t.pool.query(
    `insert into identity.users (id, org_id, email, display_name, password_hash, status, created_at) values ($1, $2, $3, $5, $4, 'active', now())`,
    [id, org, email, await hashPassword('trace test password'), email],
  );
  expect((await lead.fetch(V(`/members/${id}`), send('PUT', { role }))).status).toBe(200);
  return signIn(base, email, 'trace test password');
}

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-trace-'));
  api = await createApiApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_PORT: '0',
    RATE_LIMIT_BURST: '5000',
    RATE_LIMIT_RPS: '5000',
    STORAGE_DIR: dir,
    ...AUTH_ENV,
  });
  base = await api.listen();
  lead = await setupAndSignIn(base);
  await json(await lead.fetch(`${base}/api/v1/projects`, send('POST', { key: 'TRC', name: 'Trace' })));
  projectId = (await t.pool.query(`select id from projects.projects where key = 'TRC'`)).rows[0].id;
  sourceId = (
    await json<{ id: string }>(
      await lead.fetch(V('/requirement-sources'), send('POST', { kind: 'document_set', name: 'Rules' })),
    )
  ).id;
  reviewer = await addUser('reviewer@example.test', 'qa_lead');
  viewer = await addUser('viewer@example.test', 'viewer');

  // Version 1: accept the five numbered requirements, approve REQ-1, link tests to REQ-1, REQ-2, REQ-4.
  snap1 = await uploadAndParse('library-v1.pdf', 'p09-library-en-numbered.pdf');
  const keyed = (await candidates(snap1)).filter((c) => c.externalKey);
  expect(keyed.map((c) => c.externalKey)).toEqual(['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4', 'REQ-5']);
  const accepted = await json<{ created: { itemId: string; key: string }[] }>(
    await lead.fetch(V('/candidates/accept'), send('POST', { itemIds: keyed.map((c) => c.id) })),
  );
  for (const c of accepted.created) keyOf[keyed.find((k) => k.id === c.itemId)!.externalKey!] = c.key;
  await json(await lead.fetch(V(`/requirements/${keyOf['REQ-1']}/submit`), send('POST')));
  await json(
    await reviewer.fetch(
      V(`/requirements/${keyOf['REQ-1']}/decision`),
      send('POST', { decision: 'approve' }),
    ),
  );
  const reqId = async (key: string) =>
    (await t.pool.query(`select id from requirements.requirements where key = $1`, [key])).rows[0]
      .id as string;
  for (const [tc, req] of [
    [testCase.r1, 'REQ-1'],
    [testCase.r4, 'REQ-4'],
    [testCase.r2, 'REQ-2'],
  ] as const) {
    await createLink(api.infra.db, project(), {
      type: 'verifies',
      from: { type: 'test_case', id: tc, versionId: uuidv7() },
      to: { type: 'requirement', id: await reqId(keyOf[req]!) },
      origin: 'system',
      createdBy: null,
    });
  }
  snap2 = await uploadAndParse('library-v2.pdf', 's17-booking-en-numbered.pdf');
}, 240_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('document changes and impact (T-P3-11, M04-AC-04)', () => {
  it('shows added, changed and removed requirements against version 1 and lists every affected test case', async () => {
    const c = await json<Changes>(await lead.fetch(V(`/snapshots/${snap2}/changes`)));
    expect(c.previousSnapshotId).toBe(snap1);
    expect(c.added.map((a) => a.externalKey)).toEqual(['REQ-6']);
    expect(c.removed.map((r) => [r.externalKey, r.requirement?.key])).toEqual([['REQ-4', keyOf['REQ-4']]]);
    expect(c.changed).toHaveLength(1);
    expect(c.changed[0]).toMatchObject({
      before: { externalKey: 'REQ-1', requirement: { key: keyOf['REQ-1'] } },
      after: { externalKey: 'REQ-1', requirement: null },
      fields: ['title', 'body', 'acceptanceCriteria'],
      ac: {
        added: ["Borrowing an 8th item shows 'Borrowing limit reached'."],
        removed: ["Borrowing a 6th item shows 'Borrowing limit reached'."],
      },
    });
    expect(
      c.unchanged
        .map((u) => u.after.externalKey)
        .filter(Boolean)
        .sort(),
    ).toEqual(['REQ-2', 'REQ-3', 'REQ-5']);
    expect(c.impact.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: keyOf['REQ-1'], change: 'changed' }),
        expect.objectContaining({ key: keyOf['REQ-4'], change: 'removed' }),
      ]),
    );
    expect(c.impact.requirements).toHaveLength(2);
    expect(c.impact.testCases.map((x) => [x.testCaseId, x.requirementKey]).sort()).toEqual(
      [
        [testCase.r1, keyOf['REQ-1']],
        [testCase.r4, keyOf['REQ-4']],
      ].sort(),
    );
    // Comparing changes nothing.
    expect((await detail(keyOf['REQ-1']!)).latestVersion).toBe(1);
  });

  it('a version without a previous one, or another source’s snapshot, cannot be compared', async () => {
    expect(await code(await lead.fetch(V(`/snapshots/${snap1}/changes`)))).toBe('snapshot.no_previous');
    expect(await code(await lead.fetch(V(`/snapshots/${snap2}/changes?against=${snap2}`)))).toBe(
      'snapshot.not_comparable',
    );
    expect((await viewer.fetch(V(`/snapshots/${snap2}/apply-changes`), send('POST'))).status).toBe(403);
  });

  it('applying creates a draft version, keeps the approved one effective, marks removals and flags tests', async () => {
    const out = await json<{
      carried: number;
      newVersions: { key: string; version: number }[];
      markedRemoved: string[];
      skipped: unknown[];
      flaggedLinks: number;
      added: number;
    }>(await lead.fetch(V(`/snapshots/${snap2}/apply-changes`), send('POST')));
    expect(out).toEqual({
      carried: 3,
      newVersions: [{ key: keyOf['REQ-1'], version: 2 }],
      markedRemoved: [keyOf['REQ-4']],
      skipped: [],
      flaggedLinks: 2,
      added: 1, // REQ-6 (the "Functional requirements" heading candidate is in both versions)
    });
    const r1 = await detail(keyOf['REQ-1']!);
    expect(r1).toMatchObject({ state: 'draft', effectiveVersion: 1, latestVersion: 2 });
    expect(r1.versions.find((v) => v.number === 1)!.state).toBe('approved');
    expect(r1.versions.find((v) => v.number === 2)!.acceptanceCriteria.map((a) => a.text)).toContain(
      "Borrowing an 8th item shows 'Borrowing limit reached'.",
    );
    expect(new Set(r1.provenance.map((p) => p.snapshotId))).toEqual(new Set([snap2]));
    expect((await detail(keyOf['REQ-4']!)).sourceRemoved).toBe(true);
    // Unchanged requirements now also point at version 2; no new version.
    const r2 = await detail(keyOf['REQ-2']!);
    expect(r2.latestVersion).toBe(1);
    expect(new Set(r2.provenance.map((p) => p.snapshotId))).toEqual(new Set([snap1, snap2]));
    const tr1 = await trace(keyOf['REQ-1']!);
    expect(tr1.verifiedBy).toEqual([
      expect.objectContaining({
        testCaseId: testCase.r1,
        needsReview: true,
        reviewReason: expect.objectContaining({ kind: 'source_changed' }),
      }),
    ]);
    expect((await trace(keyOf['REQ-4']!)).verifiedBy[0]).toMatchObject({
      needsReview: true,
      reviewReason: { kind: 'source_removed' },
    });
    expect((await trace(keyOf['REQ-2']!)).verifiedBy[0]!.needsReview).toBe(false);
    const audit = await t.pool.query(
      `select summary from governance.audit_events where action = 'requirement.document.changes_applied'`,
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('applying again changes nothing (idempotent)', async () => {
    const again = await json<{
      carried: number;
      newVersions: unknown[];
      markedRemoved: unknown[];
      flaggedLinks: number;
    }>(await lead.fetch(V(`/snapshots/${snap2}/apply-changes`), send('POST')));
    expect(again).toMatchObject({ carried: 0, newVersions: [], markedRemoved: [], flaggedLinks: 0 });
    expect((await detail(keyOf['REQ-1']!)).latestVersion).toBe(2);
  });

  it('a reviewed test link is cleared and audited', async () => {
    const link = (await trace(keyOf['REQ-1']!)).verifiedBy[0]!;
    const after = await json<Trace>(
      await lead.fetch(V(`/requirements/${keyOf['REQ-1']}/links/${link.linkId}/reviewed`), send('POST')),
    );
    expect(after.verifiedBy[0]).toMatchObject({ needsReview: false, reviewReason: null });
    expect(
      await code(
        await lead.fetch(V(`/requirements/${keyOf['REQ-2']}/links/${link.linkId}/reviewed`), send('POST')),
      ),
    ).toBe('trace.link_not_found');
  });
});

describe('merging duplicates (M04-AC-10)', () => {
  it('suggests an existing requirement and merging keeps both provenances', async () => {
    const manual = await json<Detail>(
      await lead.fetch(
        V('/requirements'),
        send('POST', {
          title: 'The system shall let members pay their fines online.',
          bodyMd: 'Online fine payment.',
        }),
      ),
    );
    const open = await candidates(snap2);
    const req6 = open.find((c) => c.externalKey === 'REQ-6')!;
    expect(req6.duplicates[0]).toMatchObject({ key: manual.key });
    expect(req6.duplicates[0]!.similarity).toBeGreaterThanOrEqual(0.5);
    expect(open.find((c) => c.externalKey !== 'REQ-6')!.duplicates).toEqual([]);

    const merged = await json<{ key: string; newVersion: number | null }>(
      await lead.fetch(V('/candidates/merge'), send('POST', { itemId: req6.id, requirementKey: manual.key })),
    );
    expect(merged).toEqual({ requirementId: expect.any(String), key: manual.key, newVersion: 2 });
    const d = await detail(manual.key);
    expect(d.sourceKinds).toEqual(['document_set', 'manual']);
    expect(d.versions[0]!.acceptanceCriteria.map((a) => a.text)).toEqual([
      'Paying online clears the fine at once.',
    ]);
    expect(
      await code(
        await lead.fetch(
          V('/candidates/merge'),
          send('POST', { itemId: req6.id, requirementKey: manual.key }),
        ),
      ),
    ).toBe('candidate.not_a_candidate');
    expect(
      await code(
        await lead.fetch(
          V('/candidates/merge'),
          send('POST', { itemId: uuidv7(), requirementKey: manual.key }),
        ),
      ),
    ).toBe('candidate.not_found');
  });
});

describe('requirement links and trace view (T-P3-12)', () => {
  it('builds a hierarchy without cycles or second parents, and symmetric related links', async () => {
    const [r2, r3, r5] = [keyOf['REQ-2']!, keyOf['REQ-3']!, keyOf['REQ-5']!];
    const t3 = await json<Trace>(
      await lead.fetch(V(`/requirements/${r3}/links`), send('POST', { type: 'child_of', targetKey: r2 })),
    );
    expect(t3.parents.map((p) => p.key)).toEqual([r2]);
    expect((await trace(r2)).children.map((c) => c.key)).toEqual([r3]);
    expect(
      await code(
        await lead.fetch(V(`/requirements/${r2}/links`), send('POST', { type: 'child_of', targetKey: r3 })),
      ),
    ).toBe('trace.cycle');
    expect(
      await code(
        await lead.fetch(V(`/requirements/${r3}/links`), send('POST', { type: 'child_of', targetKey: r5 })),
      ),
    ).toBe('trace.parent_exists');
    expect(
      await code(
        await lead.fetch(V(`/requirements/${r3}/links`), send('POST', { type: 'relates_to', targetKey: r3 })),
      ),
    ).toBe('trace.self_link');
    expect(
      await code(
        await lead.fetch(
          V(`/requirements/${r3}/links`),
          send('POST', { type: 'relates_to', targetKey: 'TRC-R-999' }),
        ),
      ),
    ).toBe('trace.target_not_found');

    const a = await json<Trace>(
      await lead.fetch(V(`/requirements/${r2}/links`), send('POST', { type: 'relates_to', targetKey: r5 })),
    );
    const b = await json<Trace>(
      await lead.fetch(V(`/requirements/${r5}/links`), send('POST', { type: 'relates_to', targetKey: r2 })),
    );
    expect(b.related.map((x) => x.key)).toEqual([r2]);
    expect(a.related[0]!.linkId).toBe(b.related[0]!.linkId);
    expect(
      (
        await viewer.fetch(
          V(`/requirements/${r5}/links`),
          send('POST', { type: 'relates_to', targetKey: r3 }),
        )
      ).status,
    ).toBe(403);

    const removed = await json<Trace>(
      await lead.fetch(V(`/requirements/${r5}/links/${b.related[0]!.linkId}`), send('DELETE')),
    );
    expect(removed.related).toEqual([]);
    expect(
      await code(await lead.fetch(V(`/requirements/${r5}/links/${b.related[0]!.linkId}`), send('DELETE'))),
    ).toBe('trace.link_not_found');
    // Test links are not removable from the requirement side.
    const testLink = (await trace(r2)).verifiedBy[0]!.linkId;
    expect(await code(await lead.fetch(V(`/requirements/${r2}/links/${testLink}`), send('DELETE')))).toBe(
      'trace.link_not_found',
    );
    expect((await trace(r2)).coverage).toBe('covered_manual');
    expect((await trace(r3)).coverage).toBe('uncovered');
  });
});

describe('export (T-P3-16)', () => {
  it('exports CSV with a byte-order mark and formula injection neutralised', async () => {
    await json(
      await lead.fetch(
        V('/requirements'),
        send('POST', { title: '=HYPERLINK("https://x.example.test","click")' }),
      ),
    );
    const res = await lead.fetch(V('/requirements-export?format=csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(
      /attachment; filename="TRC-requirements-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    const lines = text.trimEnd().split('\r\n');
    expect(lines[0]).toMatch(/^Key,Title,State,/);
    const count = (
      await t.pool.query(`select count(*)::int n from requirements.requirements where project_id = $1`, [
        projectId,
      ])
    ).rows[0].n;
    expect(text).toContain(`"'=HYPERLINK(""https://x.example.test"",""click"")"`);
    expect(lines.filter((l) => /^TRC-R-\d+,/.test(l))).toHaveLength(count);
    expect(text).toContain(`${keyOf['REQ-1']},`);

    const traceCsv = await (await lead.fetch(V('/requirements-export?format=csv&view=trace'))).text();
    expect(traceCsv).toContain(`${keyOf['REQ-3']},child_of,outgoing,requirement,${keyOf['REQ-2']}`);
    expect(traceCsv).toContain(`${keyOf['REQ-1']},verifies,incoming,test_case,${testCase.r1}`);
  });

  it('exports XLSX that is a valid workbook', async () => {
    const res = await lead.fetch(V('/requirements-export?format=xlsx'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(validateUpload('export.xlsx', bytes)).toMatchObject({ ok: true, kind: 'xlsx' });
    expect((await lead.fetch(V('/requirements-export?format=pdf'))).status).toBe(400);
    expect((await viewer.fetch(V('/requirements-export?format=csv'))).status).toBe(200);
  });
});
