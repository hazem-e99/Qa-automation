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
import { DocumentParseError, type DocumentParser, type ParsedDocument } from '@qos/ports';
import { processParseJob, type DocumentDeps } from '@qos/requirements';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { AUTH_ENV, setupAndSignIn, signIn, type Session } from './helpers.js';

/**
 * Document ingestion end to end (T-P3-04/05/06/07/08): upload through the API, the parse job run
 * with a stand-in parser that answers with the real parser's output for the P0 corpus (dumped by
 * services/parser/tools/dump_corpus.py), then review. The real sidecar is tested in services/parser.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CORPUS = path.join(ROOT, 'spikes/parser/corpus/files');
const PARSED = path.join(ROOT, 'packages/modules/requirements/test/fixtures/parsed');
const corpus = (name: string) => readFileSync(path.join(CORPUS, name));

let t: TestDatabase;
let api: ApiApp;
let base: string;
let dir: string;
let lead: Session;
let viewer: Session;
let docsSource: string;
let sheetSource: string;
const parserCalls: string[] = [];
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

/** Answers like the sidecar: the dumped output for corpus files, or a scripted failure. */
const fakeParser: DocumentParser & { failNext: DocumentParseError | null } = {
  failNext: null,
  async parse(input) {
    parserCalls.push(input.fileName);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const base = input.fileName.replace(/\.[a-z]+$/, '');
    const doc = JSON.parse(readFileSync(path.join(PARSED, `${base}.json`), 'utf8')) as ParsedDocument;
    return input.kind === 'docx' ? { ...doc, layoutHtml: `<h1>${base}</h1><p dir="rtl">نص</p>` } : doc;
  },
  async renderPage() {
    return { png: new Uint8Array(PNG), pageCount: 1 };
  },
};
const deps = (): DocumentDeps & { parser: DocumentParser } => ({
  db: api.infra.db,
  storage: api.storage,
  jobs: api.infra.jobs,
  parser: fakeParser,
});

const V = (p: string) => `${base}/api/v1/projects/DOC${p}`;
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
const code = async (res: Response) =>
  ApiError.parse(await res.json()) as { code: string; params?: Record<string, unknown> };
const upload = (s: Session, sourceId: string, fileName: string, bytes: Uint8Array, extra = '') =>
  s.fetch(V(`/requirement-sources/${sourceId}/documents?fileName=${encodeURIComponent(fileName)}${extra}`), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });

type Upload = { snapshotId: string; documentId: string; duplicate: boolean; parseStatus: string };
type Candidate = {
  id: string;
  text: string;
  externalKey: string | null;
  confidence: number;
  status: string;
  bulkAcceptable: boolean;
  locator: Record<string, unknown>;
  acceptanceCriteria: { id: string; text: string }[];
};
type Snapshot = {
  id: string;
  version: number;
  parseStatus: string;
  extractionQuality: Record<string, unknown> | null;
};

async function uploadAndParse(sourceId: string, file: string): Promise<Upload> {
  const up = await json<Upload>(await upload(lead, sourceId, file, corpus(file)));
  expect(
    await processParseJob(deps(), { projectId: await projectId(), snapshotId: up.snapshotId }),
  ).toMatchObject({
    status: 'parsed',
  });
  return up;
}
const projectId = async () =>
  (await t.pool.query(`select id from projects.projects where key = 'DOC'`)).rows[0].id as string;
const candidates = (snapshotId: string, status = 'candidate') =>
  lead.fetch(V(`/snapshots/${snapshotId}/candidates?status=${status}`)).then((r) => json<Candidate[]>(r));

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-docs-'));
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
  await json(await lead.fetch(`${base}/api/v1/projects`, send('POST', { key: 'DOC', name: 'Documents' })));
  docsSource = (
    await json<{ id: string }>(
      await lead.fetch(V('/requirement-sources'), send('POST', { kind: 'document_set', name: 'Specs' })),
    )
  ).id;
  sheetSource = (
    await json<{ id: string }>(
      await lead.fetch(
        V('/requirement-sources'),
        send('POST', { kind: 'spreadsheet', name: 'Backlog sheet' }),
      ),
    )
  ).id;
  const id = uuidv7();
  const org = (await t.pool.query('select id from identity.organizations')).rows[0].id;
  await t.pool.query(
    `insert into identity.users (id, org_id, email, display_name, password_hash, status, created_at) values ($1, $2, 'viewer@example.test', 'Viewer', $3, 'active', now())`,
    [id, org, await hashPassword('documents test password')],
  );
  expect((await lead.fetch(V(`/members/${id}`), send('PUT', { role: 'viewer' }))).status).toBe(200);
  viewer = await signIn(base, 'viewer@example.test', 'documents test password');
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('upload validation (T-P3-04)', () => {
  it('rejects encrypted, truncated, disguised and zip-bomb files before storing or parsing anything (M04-AC-08)', async () => {
    const cases: [string, string][] = [
      ['m27-truncated-en.pdf', 'truncated_pdf'],
      ['m28-encrypted-en.pdf', 'encrypted_pdf'],
      ['m29-zipbomb.docx', 'zip_bomb_suspected'],
      ['m30-disguised-exe.pdf', 'executable'],
    ];
    for (const [file, reason] of cases) {
      const res = await upload(lead, docsSource, file, corpus(file));
      expect(res.status, file).toBe(422);
      expect(await code(res), file).toMatchObject({ code: 'upload.rejected', params: { reason } });
    }
    expect(
      (
        await t.pool.query(
          `select count(*)::int as n from requirements.source_snapshots where source_id = $1`,
          [docsSource],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await t.pool.query(`select count(*)::int as n from pgboss.job where name = 'requirements.parse'`))
        .rows[0].n,
    ).toBe(0);
    expect(parserCalls).toEqual([]);
    const audit = await t.pool.query(
      `select summary from governance.audit_events where action = 'requirement.upload.rejected'`,
    );
    expect(audit.rows.map((r) => r.summary.reason).sort()).toEqual(cases.map((c) => c[1]).sort());
  });

  it('decides the type from the bytes, and checks what each source accepts', async () => {
    // A PDF named .docx is still a PDF; a DOCX is refused by a spreadsheet source.
    const pdfAsDocx = await upload(lead, docsSource, 'renamed.docx', corpus('p09-library-en-numbered.pdf'));
    expect(await code(pdfAsDocx)).toMatchObject({
      code: 'upload.rejected',
      params: { reason: 'magic_bytes_mismatch' },
    });
    const docxToSheet = await upload(
      lead,
      sheetSource,
      'd02-auth-en-table.docx',
      corpus('d02-auth-en-table.docx'),
    );
    expect(await code(docxToSheet)).toMatchObject({
      code: 'upload.rejected',
      params: { reason: 'unsupported_type' },
    });
    const manual = await json<{ id: string }[]>(await lead.fetch(V('/requirement-sources')));
    expect(manual).toHaveLength(2);
    const noName = await lead.fetch(V(`/requirement-sources/${docsSource}/documents`), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: corpus('d02-auth-en-table.docx'),
    });
    expect(await code(noName)).toMatchObject({ code: 'upload.file_name_required' });
    expect(
      (await upload(viewer, docsSource, 'd02-auth-en-table.docx', corpus('d02-auth-en-table.docx'))).status,
    ).toBe(403);
  });

  it('stores a valid upload as a pending snapshot, queues one parse job, and dedupes by checksum', async () => {
    const first = await upload(lead, docsSource, 'd02-auth-en-table.docx', corpus('d02-auth-en-table.docx'));
    expect(first.status).toBe(201);
    const up = await json<Upload>(first);
    expect(up).toMatchObject({ duplicate: false, parseStatus: 'pending' });
    const again = await upload(lead, docsSource, 'd02-auth-en-table.docx', corpus('d02-auth-en-table.docx'));
    expect(again.status).toBe(200);
    expect(await json<Upload>(again)).toEqual({ ...up, duplicate: true });
    const jobs = await t.pool.query(`select data from pgboss.job where name = 'requirements.parse'`);
    expect(jobs.rows.map((r) => r.data.data.snapshotId)).toEqual([up.snapshotId]);
    const snap = await json<Snapshot & { fileName: string; sizeBytes: number }>(
      await lead.fetch(V(`/snapshots/${up.snapshotId}`)),
    );
    expect(snap).toMatchObject({ version: 1, parseStatus: 'pending', fileName: 'd02-auth-en-table.docx' });
    expect(snap.sizeBytes).toBe(corpus('d02-auth-en-table.docx').byteLength);
  });
});

describe('parse job and candidates (T-P3-05/06)', () => {
  let snapshotId: string;

  it('parses a pending snapshot once and stores candidates with locators; redelivery is a no-op', async () => {
    snapshotId = (
      await t.pool.query(`select id from requirements.source_snapshots where source_id = $1`, [docsSource])
    ).rows[0].id;
    const pid = await projectId();
    expect(await processParseJob(deps(), { projectId: pid, snapshotId })).toEqual({
      status: 'parsed',
      candidates: 14,
    });
    expect(await processParseJob(deps(), { projectId: pid, snapshotId })).toEqual({ status: 'skipped' });
    // A job carrying another project's id does nothing.
    expect(await processParseJob(deps(), { projectId: uuidv7(), snapshotId })).toEqual({ status: 'skipped' });
    const snap = await json<Snapshot>(await lead.fetch(V(`/snapshots/${snapshotId}`)));
    expect(snap.parseStatus).toBe('parsed');
    expect(snap.extractionQuality).toMatchObject({
      requirements: 6,
      acceptanceCriteria: 8,
      needsReview: false,
    });
    const list = await candidates(snapshotId);
    expect(list).toHaveLength(6);
    expect(list.every((c) => c.locator.table !== undefined && c.locator.row !== undefined)).toBe(true);
    expect(list.filter((c) => c.externalKey).length).toBe(6);
    expect(list.flatMap((c) => c.acceptanceCriteria)).toHaveLength(8);
    const parsed = await t.pool.query(
      `select parser_version, block_count from requirements.parsed_documents where snapshot_id = $1`,
      [snapshotId],
    );
    expect(parsed.rows[0].block_count).toBeGreaterThan(0);
  });

  it('fails a snapshot on a final parser error, and leaves it pending on an outage (retried)', async () => {
    const pid = await projectId();
    const bad = await json<Upload>(
      await upload(lead, docsSource, 'd04-leave-en-prose.docx', corpus('d04-leave-en-prose.docx')),
    );
    fakeParser.failNext = new DocumentParseError('parser_unavailable', true);
    await expect(
      processParseJob(deps(), { projectId: pid, snapshotId: bad.snapshotId }),
    ).rejects.toMatchObject({ retryable: true });
    expect((await json<Snapshot>(await lead.fetch(V(`/snapshots/${bad.snapshotId}`)))).parseStatus).toBe(
      'pending',
    );
    fakeParser.failNext = new DocumentParseError('docx_unreadable', false);
    expect(await processParseJob(deps(), { projectId: pid, snapshotId: bad.snapshotId })).toEqual({
      status: 'failed',
      error: 'docx_unreadable',
    });
    const snap = await json<Snapshot>(await lead.fetch(V(`/snapshots/${bad.snapshotId}`)));
    expect(snap).toMatchObject({ parseStatus: 'failed', extractionQuality: { error: 'docx_unreadable' } });
  });

  it('groups uploads of the same document into versions', async () => {
    const v2 = await json<Upload>(
      await upload(
        lead,
        docsSource,
        'd01-checkout-en-numbered.docx',
        corpus('d01-checkout-en-numbered.docx'),
        '&title=d02-auth-en-table',
      ),
    );
    const docs = await json<{ title: string; versions: { id: string; version: number }[] }[]>(
      await lead.fetch(V(`/requirement-sources/${docsSource}/documents`)),
    );
    const series = docs.find((d) => d.title === 'd02-auth-en-table')!;
    expect(series.versions.map((v) => [v.id, v.version])).toEqual([
      [snapshotId, 1],
      [v2.snapshotId, 2],
    ]);
    expect(docs.map((d) => d.title).sort()).toEqual(['d02-auth-en-table', 'd04-leave-en-prose']);
  });
});

describe('candidate review (T-P3-08)', () => {
  it('bulk accept skips low-confidence OCR candidates; one at a time they can be accepted (M04-AC-07)', async () => {
    const scan = await uploadAndParse(docsSource, 's20-library-ar-scanned.pdf');
    const snap = await json<Snapshot>(await lead.fetch(V(`/snapshots/${scan.snapshotId}`)));
    expect(snap.extractionQuality).toMatchObject({ ocrPages: 1, needsReview: true });
    const list = await candidates(scan.snapshotId);
    const low = list.filter((c) => !c.bulkAcceptable);
    expect(low.length).toBeGreaterThan(0);
    expect(low.every((c) => c.confidence < 0.6)).toBe(true);
    const bulk = await json<{
      created: { itemId: string; key: string }[];
      skipped: { itemId: string; reason: string }[];
    }>(await lead.fetch(V('/candidates/accept'), send('POST', { itemIds: list.map((c) => c.id) })));
    expect(bulk.created.map((c) => c.itemId).sort()).toEqual(
      list
        .filter((c) => c.bulkAcceptable)
        .map((c) => c.id)
        .sort(),
    );
    expect(bulk.skipped).toEqual(low.map((c) => ({ itemId: c.id, reason: 'low_confidence' })));
    const single = await json<{ created: { key: string }[] }>(
      await lead.fetch(V('/candidates/accept'), send('POST', { itemIds: [low[0]!.id] })),
    );
    expect(single.created).toHaveLength(1);
    // Accepting twice creates nothing.
    const twice = await json<{ created: unknown[]; skipped: { reason: string }[] }>(
      await lead.fetch(V('/candidates/accept'), send('POST', { itemIds: [low[0]!.id] })),
    );
    expect(twice).toEqual({ created: [], skipped: [{ itemId: low[0]!.id, reason: 'not_a_candidate' }] });
  });

  it('an accepted candidate becomes a draft requirement with its criteria and provenance', async () => {
    const snapshotId = (
      await t.pool.query(
        `select id from requirements.source_snapshots where file_name = 'd02-auth-en-table.docx'`,
      )
    ).rows[0].id;
    const [first] = await candidates(snapshotId);
    const out = await json<{ created: { key: string }[] }>(
      await lead.fetch(V('/candidates/accept'), send('POST', { itemIds: [first!.id] })),
    );
    const r = await json<{
      state: string;
      origin: string;
      sourceKinds: string[];
      versions: { title: string; bodyMd: string; acceptanceCriteria: { text: string; origin: string }[] }[];
      provenance: {
        sourceKind: string;
        method: string;
        locator: Record<string, unknown>;
        snapshotId: string;
      }[];
    }>(await lead.fetch(V(`/requirements/${out.created[0]!.key}`)));
    expect(r).toMatchObject({ state: 'draft', sourceKinds: ['document_set'] });
    expect(r.versions[0]!.title.startsWith(`${first!.externalKey}: `)).toBe(true);
    expect(r.versions[0]!.bodyMd).toBe(first!.text);
    expect(r.versions[0]!.acceptanceCriteria.map((a) => a.text)).toEqual(
      first!.acceptanceCriteria.map((a) => a.text),
    );
    expect(r.versions[0]!.acceptanceCriteria.every((a) => a.origin === 'source')).toBe(true);
    expect(r.provenance.length).toBe(1 + first!.acceptanceCriteria.length);
    expect(
      r.provenance.every(
        (p) => p.method === 'structural' && p.snapshotId === snapshotId && p.locator.row !== undefined,
      ),
    ).toBe(true);
  });

  it('rejects candidates with their criteria; viewers can do neither', async () => {
    const snapshotId = (
      await t.pool.query(
        `select id from requirements.source_snapshots where file_name = 'd02-auth-en-table.docx'`,
      )
    ).rows[0].id;
    const [c] = await candidates(snapshotId);
    expect((await viewer.fetch(V('/candidates/reject'), send('POST', { itemIds: [c!.id] }))).status).toBe(
      403,
    );
    expect((await viewer.fetch(V('/candidates/accept'), send('POST', { itemIds: [c!.id] }))).status).toBe(
      403,
    );
    expect(
      await json(
        await lead.fetch(V('/candidates/reject'), send('POST', { itemIds: [c!.id], reason: 'duplicate' })),
      ),
    ).toEqual({ rejected: 1 });
    expect(await json(await lead.fetch(V('/candidates/reject'), send('POST', { itemIds: [c!.id] })))).toEqual(
      { rejected: 0 },
    );
    const acs = await t.pool.query(
      `select status from requirements.extracted_items where parent_item_id = $1`,
      [c!.id],
    );
    expect(acs.rows.every((r) => r.status === 'rejected')).toBe(true);
    // Unknown ids are reported, not guessed.
    const ghost = uuidv7();
    expect(await json(await lead.fetch(V('/candidates/accept'), send('POST', { itemIds: [ghost] })))).toEqual(
      {
        created: [],
        skipped: [{ itemId: ghost, reason: 'not_found' }],
      },
    );
  });
});

describe('spreadsheet mapping (T-P3-07)', () => {
  let sheet: Upload;

  it('suggests column roles from the header and previews what a mapping extracts', async () => {
    sheet = await uploadAndParse(sheetSource, 'x22-auth-en-sheet.xlsx');
    const preview = await json<{
      tables: { header: string[]; suggested: Record<string, number> }[];
      requirements: number;
      acceptanceCriteria: number;
      sample: { externalKey: string | null; acceptanceCriteria: string[] }[];
    }>(await lead.fetch(V(`/snapshots/${sheet.snapshotId}/mapping-preview`), send('POST', {})));
    expect(preview.tables).toHaveLength(1);
    expect(preview.tables[0]!.suggested.text).toBeDefined();
    expect(preview.requirements).toBe(6);
    // A mapping without the AC column extracts the same rows, no criteria.
    const { ac: _ac, ...noAc } = preview.tables[0]!.suggested;
    const narrowed = await json<typeof preview>(
      await lead.fetch(V(`/snapshots/${sheet.snapshotId}/mapping-preview`), send('POST', { mapping: noAc })),
    );
    expect(narrowed).toMatchObject({ requirements: 6, acceptanceCriteria: 0 });
    expect(
      await code(
        await lead.fetch(
          V(`/snapshots/${sheet.snapshotId}/mapping-preview`),
          send('POST', { mapping: { id: 1 } }),
        ),
      ),
    ).toMatchObject({
      code: 'mapping.text_required',
    });
  });

  it('saves a mapping on the source and re-extracts; decided rows are not offered again', async () => {
    const before = await candidates(sheet.snapshotId);
    await json(await lead.fetch(V('/candidates/accept'), send('POST', { itemIds: [before[0]!.id] })));
    const bad = await lead.fetch(
      V(`/requirement-sources/${sheetSource}`),
      send('PATCH', { config: { mapping: { text: 0 } } }),
    );
    expect(bad.status).toBe(400);
    const preview = await json<{ tables: { suggested: Record<string, number> }[] }>(
      await lead.fetch(V(`/snapshots/${sheet.snapshotId}/mapping-preview`), send('POST', {})),
    );
    const { ac: _ac, ...noAc } = preview.tables[0]!.suggested;
    await json(
      await lead.fetch(
        V(`/requirement-sources/${sheetSource}`),
        send('PATCH', { config: { mapping: noAc } }),
      ),
    );
    const out = await json<{ replaced: number; candidates: number }>(
      await lead.fetch(V(`/snapshots/${sheet.snapshotId}/re-extract`), send('POST')),
    );
    expect(out).toEqual({
      replaced:
        5 + (before.flatMap((c) => c.acceptanceCriteria).length - before[0]!.acceptanceCriteria.length),
      candidates: 5,
    });
    const after = await candidates(sheet.snapshotId);
    expect(after).toHaveLength(5);
    expect(after.some((c) => c.text === before[0]!.text)).toBe(false);
    expect(after.every((c) => c.acceptanceCriteria.length === 0)).toBe(true);
    expect((await candidates(sheet.snapshotId, 'accepted')).map((c) => c.id)).toEqual([before[0]!.id]);
    expect((await lead.fetch(V(`/snapshots/${sheet.snapshotId}/re-extract`), send('POST'))).status).toBe(200);
  });

  it('a project with document, sheet and manual sources has one list, each item with its source (M04-AC-01, partial)', async () => {
    await json(
      await lead.fetch(
        V('/requirements'),
        send('POST', { title: 'Manual requirement for the unified list' }),
      ),
    );
    const list = await json<{ key: string; sourceKinds: string[] }[]>(await lead.fetch(V('/requirements')));
    const kinds = new Set(list.flatMap((r) => r.sourceKinds));
    expect([...kinds].sort()).toEqual(['document_set', 'manual', 'spreadsheet']);
    expect(list.every((r) => r.sourceKinds.length >= 1)).toBe(true);
  });
});

describe('candidate split (M04-FR-08)', () => {
  it('splits a candidate into new ones at the same place; its criteria follow the first part', async () => {
    const up = await uploadAndParse(docsSource, 'd01-checkout-en-numbered.docx');
    const open = await candidates(up.snapshotId);
    const target = open.find((c) => c.acceptanceCriteria.length > 0)!;
    const res = await json<{ itemIds: string[] }>(
      await lead.fetch(
        V('/candidates/split'),
        send('POST', {
          itemId: target.id,
          parts: ['First half of the rule.', '  ', 'Second half of the rule.'],
        }),
      ),
    );
    expect(res.itemIds).toHaveLength(2);
    const after = await candidates(up.snapshotId);
    expect(after.map((c) => c.id)).not.toContain(target.id);
    const first = after.find((c) => c.id === res.itemIds[0])!;
    const second = after.find((c) => c.id === res.itemIds[1])!;
    expect(first).toMatchObject({
      text: 'First half of the rule.',
      externalKey: target.externalKey,
      locator: target.locator,
    });
    expect(first.acceptanceCriteria.map((a) => a.id)).toEqual(target.acceptanceCriteria.map((a) => a.id));
    expect(second).toMatchObject({
      text: 'Second half of the rule.',
      externalKey: null,
      acceptanceCriteria: [],
    });
    expect(
      await code(await lead.fetch(V('/candidates/split'), send('POST', { itemId: target.id, parts: ['x'] }))),
    ).toMatchObject({
      code: 'candidate.not_a_candidate',
    });
    expect(
      await code(
        await lead.fetch(V('/candidates/split'), send('POST', { itemId: second.id, parts: [second.text] })),
      ),
    ).toMatchObject({ code: 'candidate.split_invalid' });
    expect(
      (await viewer.fetch(V('/candidates/split'), send('POST', { itemId: second.id, parts: ['a', 'b'] })))
        .status,
    ).toBe(403);
  });
});

describe('PDF pages for the source viewer (T-P3-14)', () => {
  it('serves the pages rendered at parse time, and nothing else', async () => {
    const pdf = await uploadAndParse(docsSource, 'p11-leave-en-stories.pdf');
    const snap = await json<{ renderedPages: number; extractionQuality: { pages: number } }>(
      await lead.fetch(V(`/snapshots/${pdf.snapshotId}`)),
    );
    expect(snap.renderedPages).toBe(Math.min(snap.extractionQuality.pages, 30));
    expect(snap.renderedPages).toBeGreaterThan(0);
    const page = await viewer.fetch(V(`/snapshots/${pdf.snapshotId}/pages/1`));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('image/png');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await page.arrayBuffer())).toEqual(PNG);
    for (const p of ['0', String(snap.renderedPages + 1), 'x', '../parsed.json'])
      expect((await lead.fetch(V(`/snapshots/${pdf.snapshotId}/pages/${p}`))).status, p).toBe(404);
    const docx = await uploadAndParse(docsSource, 'd06-auth-ar-table.docx');
    const res = await lead.fetch(V(`/snapshots/${docx.snapshotId}/pages/1`));
    expect(res.status).toBe(404);
    expect(await code(res)).toMatchObject({ code: 'page.not_found' });
  });
});

describe('DOCX layout for the source viewer (T-P3-14)', () => {
  it('serves the sanitized layout of a DOCX as data, kept out of the parsed blocks', async () => {
    const docx = await uploadAndParse(docsSource, 'd07-booking-ar-stories.docx');
    const layout = await json<{ html: string }>(
      await viewer.fetch(V(`/snapshots/${docx.snapshotId}/layout`)),
    );
    expect(layout.html).toBe('<h1>d07-booking-ar-stories</h1><p dir="rtl">نص</p>');
    const parsed = await json<Record<string, unknown>>(
      await lead.fetch(V(`/snapshots/${docx.snapshotId}/parsed`)),
    );
    expect(parsed).not.toHaveProperty('layoutHtml');
    expect(Array.isArray(parsed.blocks)).toBe(true);
    const sheet = await json<{ id: string }[]>(
      await lead.fetch(V(`/requirement-sources/${sheetSource}/documents`)),
    );
    const sheetSnapshot = (sheet[0] as unknown as { versions: { id: string }[] }).versions[0]!.id;
    const none = await lead.fetch(V(`/snapshots/${sheetSnapshot}/layout`));
    expect(none.status).toBe(404);
    expect(await code(none)).toMatchObject({ code: 'layout.not_found' });
  });
});
