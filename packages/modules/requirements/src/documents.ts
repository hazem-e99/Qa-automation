import { createHash } from 'node:crypto';
import {
  and,
  appendAudit,
  asc,
  eq,
  extractedItems,
  inArray,
  parsedDocuments,
  projects,
  requirements,
  requirementSources,
  sourceDocuments,
  sourceSnapshots,
  sql,
  type Db,
  type Tx,
} from '@qos/db';
import type { Principal } from '@qos/identity';
import { appendOutbox, QUEUES } from '@qos/jobs';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import { assertProjectWritable, nextSequenceValue, type Project } from '@qos/projects';
import {
  DocumentParseError,
  type DocumentParser,
  type JobQueue,
  type ObjectStorage,
  type ParsedDocument,
} from '@qos/ports';
import { flagForReview } from '@qos/traceability';
import { normalizeForSearch, originOf, searchTextOf } from './domain.js';
import {
  extractCandidates,
  tableHeaders,
  type Candidate,
  type ColumnMapping,
  type ColumnRole,
} from './extraction.js';
import { audit, clean, contentFrom, insertVersion, sourceDrivenVersion } from './shared.js';
import { DEFAULT_UPLOAD_LIMITS, validateUpload, type UploadLimits } from './upload-validation.js';

/**
 * Document and spreadsheet ingestion (T-P3-04/05/06/07/08): upload → validation → stored
 * snapshot → `requirements.parse` job → parser sidecar → extracted candidates → human review.
 * Every function takes the project (ProjectScope). The parse job is idempotent: it only acts on
 * a snapshot still `pending` (expected-state update).
 */
export interface DocumentDeps {
  readonly db: Db;
  readonly storage: ObjectStorage;
  readonly jobs: JobQueue<Tx>;
}

/** Below this confidence a candidate can only be accepted on its own, never in bulk (BR-M04-7, M04-AC-07). */
export const BULK_ACCEPT_MIN_CONFIDENCE = 0.6;
/** Trigram similarity from which an existing requirement is suggested as a duplicate (M04-FR-12 fallback, OD-06). */
export const DUPLICATE_MIN_SIMILARITY = 0.5;
/** PDF pages rendered as images for the source viewer; later pages are shown as text only. */
export const MAX_RENDERED_PAGES = 30;
const UPLOAD_SOURCE_KINDS = ['document_set', 'spreadsheet'];
const SPREADSHEET_KINDS = ['xlsx', 'csv'];

const objectKey = (project: Project, sourceId: string, snapshotId: string, name: string) =>
  `projects/${project.id}/requirement-sources/${sourceId}/snapshots/${snapshotId}/${name}`;

/** Display name only: never used for paths or parser decisions. */
const safeFileName = (name: string) =>
  [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === '/' || ch === '\\' ? '_' : ch))
    .join('')
    .trim()
    .slice(0, 200) || 'upload';
const titleOf = (fileName: string) =>
  fileName
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .trim()
    .slice(0, 200) || fileName;

// ---------- mapping (T-P3-07) ----------

const ROLES: readonly ColumnRole[] = ['id', 'text', 'ac', 'priority', 'module', 'title'];

/** Validates a spreadsheet column mapping (1-based columns); `text` is required. */
export function parseMapping(raw: unknown): ColumnMapping {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError('mapping.invalid');
  const out: ColumnMapping = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(ROLES as readonly string[]).includes(k)) throw new DomainError('mapping.invalid', { field: k });
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 500)
      throw new DomainError('mapping.invalid', { field: k });
    out[k as ColumnRole] = v as number;
  }
  if (out.text === undefined) throw new DomainError('mapping.text_required');
  return out;
}

const mappingOf = (config: unknown): ColumnMapping | undefined => {
  const m = (config as { mapping?: unknown } | null)?.mapping;
  if (m === undefined || m === null) return undefined;
  try {
    return parseMapping(m);
  } catch {
    return undefined;
  }
};

// ---------- upload (T-P3-04) ----------

export interface UploadResult {
  readonly snapshotId: string;
  readonly documentId: string;
  readonly duplicate: boolean;
  readonly parseStatus: string;
}

async function loadSource(db: Db | Tx, project: Project, sourceId: string) {
  const [source] = await db
    .select()
    .from(requirementSources)
    .where(and(eq(requirementSources.id, sourceId), eq(requirementSources.projectId, project.id)));
  if (!source) throw new DomainError('requirement_source.not_found');
  return source;
}

/**
 * Stores an upload as a new snapshot of a document series and queues its parsing. The bytes are
 * validated before anything is stored (M04-AC-08). The same file uploaded twice to a source is
 * one snapshot (checksum), so a retried upload is harmless.
 */
export async function uploadDocument(
  deps: DocumentDeps,
  actor: Principal,
  project: Project,
  sourceId: string,
  input: { fileName: string; bytes: Uint8Array; documentId?: string | null; title?: string | null },
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): Promise<UploadResult> {
  assertProjectWritable(project);
  const source = await loadSource(deps.db, project, sourceId);
  if (!UPLOAD_SOURCE_KINDS.includes(source.kind)) throw new DomainError('requirement_source.not_uploadable');
  if (!source.enabled) throw new DomainError('requirement_source.disabled');
  if (!input.fileName.trim()) throw new DomainError('upload.file_name_required');
  const fileName = safeFileName(input.fileName);
  const verdict = validateUpload(fileName, input.bytes, limits);
  const reject = async (reason: string) => {
    await deps.db.transaction((tx) =>
      audit(tx, actor, project, 'requirement.upload.rejected', 'requirement_source', sourceId, {
        fileName,
        size: input.bytes.byteLength,
        reason,
      }),
    );
    throw new DomainError('upload.rejected', { reason });
  };
  if (!verdict.ok) return reject(verdict.reason);
  if (source.kind === 'spreadsheet' && !SPREADSHEET_KINDS.includes(verdict.kind))
    return reject('unsupported_type');

  const checksum = createHash('sha256').update(input.bytes).digest('hex');
  const existing = await findByChecksum(deps.db, project, sourceId, checksum);
  if (existing) return { ...existing, duplicate: true };

  const snapshotId = uuidv7();
  const key = objectKey(project, sourceId, snapshotId, `original.${verdict.kind}`);
  await deps.storage.put(key, input.bytes, verdict.mime);
  const result = await deps.db.transaction(async (tx) => {
    const documentId = await documentFor(
      tx,
      project,
      sourceId,
      input.documentId ?? null,
      input.title ?? titleOf(fileName),
    );
    const inserted = await tx
      .insert(sourceSnapshots)
      .values({
        id: snapshotId,
        projectId: project.id,
        sourceId,
        documentId,
        checksum,
        storedObjectKey: key,
        fileName,
        fileKind: verdict.kind,
        contentType: verdict.mime,
        sizeBytes: input.bytes.byteLength,
        capturedBy: actor.userId,
        capturedAt: new Date(),
        parseStatus: 'pending',
      })
      .onConflictDoNothing()
      .returning({ id: sourceSnapshots.id });
    if (!inserted.length) return null; // a concurrent identical upload won
    await deps.jobs.send(
      QUEUES.requirementsParse.name,
      { projectId: project.id, snapshotId },
      { tx, singletonKey: snapshotId },
    );
    await audit(tx, actor, project, 'requirement.document.uploaded', 'source_snapshot', snapshotId, {
      sourceId,
      documentId,
      fileName,
      kind: verdict.kind,
      size: input.bytes.byteLength,
      checksum,
    });
    return { snapshotId, documentId, duplicate: false, parseStatus: 'pending' };
  });
  if (result) return result;
  await deps.storage.delete(key);
  const winner = await findByChecksum(deps.db, project, sourceId, checksum);
  if (!winner) throw new DomainError('upload.conflict');
  return { ...winner, duplicate: true };
}

async function findByChecksum(db: Db, project: Project, sourceId: string, checksum: string) {
  const [row] = await db
    .select({
      snapshotId: sourceSnapshots.id,
      documentId: sourceSnapshots.documentId,
      parseStatus: sourceSnapshots.parseStatus,
    })
    .from(sourceSnapshots)
    .where(
      and(
        eq(sourceSnapshots.projectId, project.id),
        eq(sourceSnapshots.sourceId, sourceId),
        eq(sourceSnapshots.checksum, checksum),
      ),
    );
  return row
    ? { snapshotId: row.snapshotId, documentId: row.documentId!, parseStatus: row.parseStatus }
    : null;
}

/** The document series an upload belongs to: the given one, or the one with the same title. */
async function documentFor(
  tx: Tx,
  project: Project,
  sourceId: string,
  documentId: string | null,
  title: string,
) {
  if (documentId) {
    const [doc] = await tx
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.id, documentId),
          eq(sourceDocuments.projectId, project.id),
          eq(sourceDocuments.sourceId, sourceId),
        ),
      );
    if (!doc) throw new DomainError('document.not_found');
    return doc.id;
  }
  const clean = title.trim().slice(0, 200);
  // Serialize series creation per source so two uploads of a new title make one series.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`qos:docseries:${sourceId}`}))`);
  const [same] = await tx
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(and(eq(sourceDocuments.sourceId, sourceId), eq(sourceDocuments.title, clean)));
  if (same) return same.id;
  const id = uuidv7();
  await tx
    .insert(sourceDocuments)
    .values({ id, projectId: project.id, sourceId, title: clean, createdAt: new Date() });
  return id;
}

// ---------- parse job (T-P3-05/06) ----------

export interface ParseJobData {
  readonly projectId: string;
  readonly snapshotId: string;
}

export interface ParseJobOutcome {
  readonly status: 'parsed' | 'failed' | 'skipped';
  readonly candidates?: number;
  readonly error?: string;
}

/**
 * Parses one pending snapshot and stores its candidates. Parser errors that will not change on
 * retry fail the snapshot; outages are rethrown so the queue retries (at-least-once).
 */
export async function processParseJob(
  deps: DocumentDeps & { parser: DocumentParser },
  data: ParseJobData,
): Promise<ParseJobOutcome> {
  const [snap] = await deps.db
    .select({ s: sourceSnapshots, config: requirementSources.config, orgId: projects.orgId })
    .from(sourceSnapshots)
    .innerJoin(requirementSources, eq(requirementSources.id, sourceSnapshots.sourceId))
    .innerJoin(projects, eq(projects.id, sourceSnapshots.projectId))
    .where(and(eq(sourceSnapshots.id, data.snapshotId), eq(sourceSnapshots.projectId, data.projectId)));
  if (!snap || snap.s.parseStatus !== 'pending' || !snap.s.storedObjectKey || !snap.s.fileKind)
    return { status: 'skipped' };
  const s = snap.s;
  let doc: ParsedDocument;
  let bytes: Uint8Array;
  try {
    bytes = await deps.storage.get(s.storedObjectKey!);
    doc = await deps.parser.parse({
      kind: s.fileKind as ParsedDocument['kind'],
      fileName: s.fileName ?? 'upload',
      bytes,
    });
  } catch (e) {
    if (!(e instanceof DocumentParseError) || e.retryable) throw e;
    const failed = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(sourceSnapshots)
        .set({ parseStatus: 'failed', extractionQuality: { error: e.code } })
        .where(and(eq(sourceSnapshots.id, s.id), eq(sourceSnapshots.parseStatus, 'pending')))
        .returning({ id: sourceSnapshots.id });
      if (!rows.length) return false;
      await systemAudit(tx, snap.orgId, s.projectId, 'requirement.document.parse_failed', s.id, {
        code: e.code,
      });
      await appendOutbox(tx, {
        type: 'requirements.snapshot.failed',
        aggregateType: 'source_snapshot',
        aggregateId: s.id,
        projectId: s.projectId,
        payload: { code: e.code },
      });
      return true;
    });
    return failed ? { status: 'failed', error: e.code } : { status: 'skipped' };
  }
  const parsedKey = s.storedObjectKey!.replace(/[^/]+$/, 'parsed.json');
  const { layoutHtml, ...blocksOnly } = doc;
  await deps.storage.put(parsedKey, new TextEncoder().encode(JSON.stringify(blocksOnly)), 'application/json');
  if (typeof layoutHtml === 'string' && layoutHtml.length)
    await deps.storage.put(
      layoutKey(s.storedObjectKey!),
      new TextEncoder().encode(layoutHtml.slice(0, 2_000_000)),
      'text/html; charset=utf-8',
    );
  const candidates = extractCandidates(doc.blocks, { mapping: mappingOf(snap.config) });
  const renderedPages =
    s.fileKind === 'pdf' ? await renderPages(deps, s.storedObjectKey!, bytes, doc.pages ?? 0) : 0;
  const done = await deps.db.transaction(async (tx) => {
    const quality = qualityOf(doc, candidates);
    const rows = await tx
      .update(sourceSnapshots)
      .set({ parseStatus: 'parsed', extractionQuality: quality })
      .where(and(eq(sourceSnapshots.id, s.id), eq(sourceSnapshots.parseStatus, 'pending')))
      .returning({ id: sourceSnapshots.id });
    if (!rows.length) return false; // another delivery finished first
    await tx
      .insert(parsedDocuments)
      .values({
        snapshotId: s.id,
        parserVersion: doc.parserVersion.slice(0, 100),
        storedObjectKey: parsedKey,
        pageCount: doc.pages,
        languages: [...doc.languages],
        ocrPages: doc.ocrPages,
        blockCount: doc.blocks.length,
        renderedPages,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    await insertCandidates(tx, s.projectId, s.id, candidates);
    await systemAudit(tx, snap.orgId, s.projectId, 'requirement.document.parsed', s.id, quality);
    await appendOutbox(tx, {
      type: 'requirements.snapshot.parsed',
      aggregateType: 'source_snapshot',
      aggregateId: s.id,
      projectId: s.projectId,
      payload: { candidates: candidates.length },
    });
    return true;
  });
  return done ? { status: 'parsed', candidates: candidates.length } : { status: 'skipped' };
}

const layoutKey = (originalKey: string) => originalKey.replace(/[^/]+$/, 'layout.html');

/**
 * The sanitized layout HTML of a DOCX snapshot (sanitized by the parser; the web app shows it in a
 * sandboxed frame). Returned as data, never served as a page of this origin.
 */
export async function getLayout(
  deps: Pick<DocumentDeps, 'db' | 'storage'>,
  project: Project,
  snapshotId: string,
): Promise<{ html: string }> {
  const [row] = await deps.db
    .select({ key: sourceSnapshots.storedObjectKey, status: sourceSnapshots.parseStatus })
    .from(sourceSnapshots)
    .where(and(eq(sourceSnapshots.id, snapshotId), eq(sourceSnapshots.projectId, project.id)));
  if (!row) throw new DomainError('snapshot.not_found');
  if (!row.key || row.status !== 'parsed' || !(await deps.storage.exists(layoutKey(row.key))))
    throw new DomainError('layout.not_found');
  return { html: new TextDecoder().decode(await deps.storage.get(layoutKey(row.key))) };
}

const pageKey = (originalKey: string, page: number) => originalKey.replace(/[^/]+$/, `pages/${page}.png`);

/**
 * Stores PDF pages as images next to the original (T-P3-14). Rendering is best effort: a page
 * the parser cannot render stops it there, and the document stays readable as text.
 */
async function renderPages(
  deps: Pick<DocumentDeps, 'storage'> & { parser: DocumentParser },
  originalKey: string,
  bytes: Uint8Array,
  pages: number,
): Promise<number> {
  if (!deps.parser.renderPage || !bytes.length) return 0;
  const last = Math.min(pages, MAX_RENDERED_PAGES);
  let done = 0;
  for (let page = 1; page <= last; page++) {
    try {
      const r = await deps.parser.renderPage({ bytes, page });
      await deps.storage.put(pageKey(originalKey, page), r.png, 'image/png');
      done = page;
    } catch (e) {
      // A retryable outage fails the job (it is retried); anything else just ends rendering.
      if (e instanceof DocumentParseError && e.retryable) throw e;
      break;
    }
  }
  return done;
}

/** A stored PDF page image of a parsed snapshot. */
export async function getPageImage(
  deps: Pick<DocumentDeps, 'db' | 'storage'>,
  project: Project,
  snapshotId: string,
  page: number,
): Promise<Uint8Array> {
  const [row] = await deps.db
    .select({ key: sourceSnapshots.storedObjectKey, rendered: parsedDocuments.renderedPages })
    .from(sourceSnapshots)
    .leftJoin(parsedDocuments, eq(parsedDocuments.snapshotId, sourceSnapshots.id))
    .where(and(eq(sourceSnapshots.id, snapshotId), eq(sourceSnapshots.projectId, project.id)));
  if (!row) throw new DomainError('snapshot.not_found');
  if (!row.key || !Number.isInteger(page) || page < 1 || page > (row.rendered ?? 0))
    throw new DomainError('page.not_found');
  return deps.storage.get(pageKey(row.key, page));
}

function qualityOf(doc: ParsedDocument, candidates: readonly Candidate[]) {
  const reqs = candidates.filter((c) => c.kind === 'requirement');
  return {
    parserVersion: doc.parserVersion,
    pages: doc.pages,
    languages: doc.languages,
    ocrPages: doc.ocrPages,
    blocks: doc.blocks.length,
    requirements: reqs.length,
    acceptanceCriteria: candidates.length - reqs.length,
    lowConfidence: candidates.filter((c) => c.confidence < BULK_ACCEPT_MIN_CONFIDENCE).length,
    // Nothing found in a document with text usually means a layout the rules do not know.
    needsReview: reqs.length === 0 || doc.ocrPages > 0,
  };
}

async function insertCandidates(
  tx: Tx,
  projectId: string,
  snapshotId: string,
  candidates: readonly Candidate[],
) {
  if (!candidates.length) return;
  const ids = candidates.map(() => uuidv7());
  const now = new Date();
  const rows = candidates.map((c, i) => ({
    id: ids[i]!,
    projectId,
    snapshotId,
    kind: c.kind,
    text: c.text.slice(0, 20_000),
    locator: c.locator,
    language: c.language,
    confidence: c.confidence.toFixed(3),
    method: 'structural',
    parentItemId: c.parent === null ? null : ids[c.parent]!,
    externalKey: c.externalKey?.slice(0, 100) ?? null,
    rule: c.rule,
    status: 'candidate',
    createdAt: now,
  }));
  for (let i = 0; i < rows.length; i += 500) await tx.insert(extractedItems).values(rows.slice(i, i + 500));
}

async function systemAudit(
  tx: Tx,
  orgId: string,
  projectId: string,
  action: string,
  snapshotId: string,
  summary: Record<string, unknown>,
) {
  await appendAudit(tx, {
    orgId,
    projectId,
    actorType: 'system',
    actorId: 'requirements.parse',
    action,
    targetType: 'source_snapshot',
    targetId: snapshotId,
    summary,
    source: 'worker',
  });
}

// ---------- reading ----------

export interface SnapshotView {
  readonly id: string;
  readonly sourceId: string;
  readonly documentId: string | null;
  readonly version: number;
  readonly fileName: string | null;
  readonly fileKind: string | null;
  readonly sizeBytes: number | null;
  readonly checksum: string;
  readonly parseStatus: string;
  readonly extractionQuality: Record<string, unknown> | null;
  readonly capturedAt: string;
  readonly counts: { candidate: number; accepted: number; rejected: number };
  /** PDF pages available as images (0: text view only). */
  readonly renderedPages: number;
}
export interface DocumentView {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly versions: SnapshotView[];
}

async function snapshotViews(
  db: Db,
  project: Project,
  where: ReturnType<typeof eq>,
): Promise<SnapshotView[]> {
  const joined = await db
    .select({ s: sourceSnapshots, rendered: parsedDocuments.renderedPages })
    .from(sourceSnapshots)
    .leftJoin(parsedDocuments, eq(parsedDocuments.snapshotId, sourceSnapshots.id))
    .where(and(eq(sourceSnapshots.projectId, project.id), where))
    .orderBy(asc(sourceSnapshots.capturedAt), asc(sourceSnapshots.id));
  if (!joined.length) return [];
  const rows = joined.map((j) => ({ ...j.s, renderedPages: j.rendered ?? 0 }));
  const counts = await db
    .select({
      snapshotId: extractedItems.snapshotId,
      status: extractedItems.status,
      n: sql<number>`count(*)::int`,
    })
    .from(extractedItems)
    .where(
      and(
        inArray(
          extractedItems.snapshotId,
          rows.map((r) => r.id),
        ),
        eq(extractedItems.kind, 'requirement'),
      ),
    )
    .groupBy(extractedItems.snapshotId, extractedItems.status);
  const perDoc = new Map<string, number>();
  return rows.map((r) => {
    const version = (perDoc.get(r.documentId ?? r.id) ?? 0) + 1;
    perDoc.set(r.documentId ?? r.id, version);
    const c = (status: string) => counts.find((x) => x.snapshotId === r.id && x.status === status)?.n ?? 0;
    return {
      id: r.id,
      sourceId: r.sourceId,
      documentId: r.documentId,
      version,
      fileName: r.fileName,
      fileKind: r.fileKind,
      sizeBytes: r.sizeBytes,
      checksum: r.checksum,
      parseStatus: r.parseStatus,
      extractionQuality: (r.extractionQuality as Record<string, unknown> | null) ?? null,
      capturedAt: r.capturedAt.toISOString(),
      counts: { candidate: c('candidate'), accepted: c('accepted'), rejected: c('rejected') },
      renderedPages: r.renderedPages,
    };
  });
}

export async function listDocuments(db: Db, project: Project, sourceId: string): Promise<DocumentView[]> {
  await loadSource(db, project, sourceId);
  const docs = await db
    .select()
    .from(sourceDocuments)
    .where(and(eq(sourceDocuments.sourceId, sourceId), eq(sourceDocuments.projectId, project.id)))
    .orderBy(asc(sourceDocuments.title));
  const snaps = await snapshotViews(db, project, eq(sourceSnapshots.sourceId, sourceId));
  return docs.map((d) => ({
    id: d.id,
    title: d.title,
    createdAt: d.createdAt.toISOString(),
    versions: snaps.filter((s) => s.documentId === d.id),
  }));
}

export async function getSnapshot(db: Db, project: Project, snapshotId: string): Promise<SnapshotView> {
  const [row] = await db
    .select({ documentId: sourceSnapshots.documentId, sourceId: sourceSnapshots.sourceId })
    .from(sourceSnapshots)
    .where(and(eq(sourceSnapshots.id, snapshotId), eq(sourceSnapshots.projectId, project.id)));
  if (!row) throw new DomainError('snapshot.not_found');
  const all = await snapshotViews(
    db,
    project,
    row.documentId ? eq(sourceSnapshots.documentId, row.documentId) : eq(sourceSnapshots.id, snapshotId),
  );
  return all.find((s) => s.id === snapshotId)!;
}

export interface CandidateView {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly externalKey: string | null;
  readonly locator: Record<string, unknown>;
  readonly language: string | null;
  readonly confidence: number;
  readonly rule: string | null;
  readonly status: string;
  readonly bulkAcceptable: boolean;
  readonly acceptanceCriteria: { id: string; text: string; confidence: number; status: string }[];
  /** Existing requirements that look like the same thing (open candidates only), best first. */
  readonly duplicates: { requirementId: string; key: string; title: string; similarity: number }[];
}

type DuplicateMatch = CandidateView['duplicates'][number];

/**
 * Duplicate suggestions by trigram similarity of the normalized text (the pg_trgm fallback of doc
 * 09 §8; embeddings come with P5). Compared against each requirement's latest version.
 */
async function duplicateSuggestions(
  db: Db,
  project: Project,
  items: readonly { id: string; text: string; externalKey: string | null; acs: readonly string[] }[],
): Promise<Map<string, DuplicateMatch[]>> {
  const out = new Map<string, DuplicateMatch[]>();
  if (!items.length) return out;
  const values = sql.join(
    items.map((i) => {
      const content = contentFrom(i.text, i.externalKey, i.acs);
      return sql`(${i.id}::uuid, ${searchTextOf(content)}, ${normalizeForSearch(content.title)})`;
    }),
    sql`, `,
  );
  // The better of whole-text and title similarity: criteria and source IDs dilute the whole text.
  const rows = await db.execute<{
    item_id: string;
    requirement_id: string;
    key: string;
    title: string;
    s: number;
  }>(sql`
    select * from (
      select c.item_id, r.id as requirement_id, r.key, v.title,
             greatest(similarity(v.search_text, c.t), similarity(lower(v.title), c.title))::float8 as s
      from (values ${values}) as c(item_id, t, title)
      join requirements.requirements r on r.project_id = ${project.id}
      join requirements.requirement_versions v on v.id = r.latest_version_id
      where v.state <> 'obsolete'
    ) m
    where m.s >= ${DUPLICATE_MIN_SIMILARITY}
    order by m.item_id, m.s desc`);
  for (const r of rows.rows) {
    const list = out.get(r.item_id) ?? [];
    if (list.length < 3)
      list.push({
        requirementId: r.requirement_id,
        key: r.key,
        title: r.title,
        similarity: Math.round(Number(r.s) * 1000) / 1000,
      });
    out.set(r.item_id, list);
  }
  return out;
}

/** Requirement candidates of a snapshot, each with its acceptance-criterion candidates. */
export async function listCandidates(
  db: Db,
  project: Project,
  snapshotId: string,
  filter: { status?: string } = {},
): Promise<CandidateView[]> {
  await getSnapshot(db, project, snapshotId);
  const rows = await db
    .select()
    .from(extractedItems)
    .where(and(eq(extractedItems.snapshotId, snapshotId), eq(extractedItems.projectId, project.id)))
    .orderBy(asc(extractedItems.id));
  const acs = rows.filter((r) => r.kind === 'ac');
  const listed = rows.filter(
    (r) => r.kind === 'requirement' && (!filter.status || r.status === filter.status),
  );
  const live = (id: string) => acs.filter((a) => a.parentItemId === id && a.status !== 'replaced');
  const dups = await duplicateSuggestions(
    db,
    project,
    listed
      .filter((r) => r.status === 'candidate')
      .map((r) => ({
        id: r.id,
        text: r.text,
        externalKey: r.externalKey,
        acs: live(r.id).map((a) => a.text),
      })),
  );
  return listed.map((r) => ({
    id: r.id,
    kind: r.kind,
    text: r.text,
    externalKey: r.externalKey,
    locator: r.locator as Record<string, unknown>,
    language: r.language,
    confidence: Number(r.confidence),
    rule: r.rule,
    status: r.status,
    bulkAcceptable: Number(r.confidence) >= BULK_ACCEPT_MIN_CONFIDENCE,
    acceptanceCriteria: live(r.id).map((a) => ({
      id: a.id,
      text: a.text,
      confidence: Number(a.confidence),
      status: a.status,
    })),
    duplicates: dups.get(r.id) ?? [],
  }));
}

// ---------- review (T-P3-08) ----------

export interface AcceptOutcome {
  readonly created: { itemId: string; requirementId: string; key: string }[];
  readonly skipped: { itemId: string; reason: 'low_confidence' | 'not_a_candidate' | 'not_found' }[];
}

/**
 * Turns requirement candidates into draft requirements with their criteria and provenance.
 * Accepting several at once skips candidates below the confidence floor (M04-AC-07); one at a
 * time, any candidate can be accepted. A candidate is accepted once (expected-state update).
 */
export async function acceptCandidates(
  db: Db,
  actor: Principal,
  project: Project,
  itemIds: readonly string[],
): Promise<AcceptOutcome> {
  assertProjectWritable(project);
  const ids = [...new Set(itemIds)];
  if (!ids.length || ids.length > 500) throw new DomainError('candidates.count_invalid');
  const bulk = ids.length > 1;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(extractedItems)
      .where(
        and(
          inArray(extractedItems.id, ids),
          eq(extractedItems.projectId, project.id),
          eq(extractedItems.kind, 'requirement'),
        ),
      )
      .for('update');
    const created: AcceptOutcome['created'][number][] = [];
    const skipped: AcceptOutcome['skipped'][number][] = [];
    for (const id of ids) {
      const item = rows.find((r) => r.id === id);
      if (!item) {
        skipped.push({ itemId: id, reason: 'not_found' });
        continue;
      }
      if (item.status !== 'candidate') {
        skipped.push({ itemId: id, reason: 'not_a_candidate' });
        continue;
      }
      if (bulk && Number(item.confidence) < BULK_ACCEPT_MIN_CONFIDENCE) {
        skipped.push({ itemId: id, reason: 'low_confidence' });
        continue;
      }
      const acs = await tx
        .select()
        .from(extractedItems)
        .where(and(eq(extractedItems.parentItemId, id), eq(extractedItems.status, 'candidate')))
        .orderBy(asc(extractedItems.id));
      const content = clean(
        contentFrom(item.text, item.externalKey, acs.map((a) => a.text.slice(0, 5000)).slice(0, 100)),
      );
      const n = await nextSequenceValue(tx, project.id, 'requirement');
      const key = `${project.key}-R-${n}`;
      const requirementId = uuidv7();
      const now = new Date();
      await tx
        .insert(requirements)
        .values({ id: requirementId, projectId: project.id, key, createdAt: now, updatedAt: now });
      await insertVersion(tx, actor, project, requirementId, 1, content, originOf('source', content), [
        id,
        ...acs.map((a) => a.id),
      ]);
      await tx
        .update(extractedItems)
        .set({ status: 'accepted' })
        .where(
          and(
            inArray(extractedItems.id, [id, ...acs.map((a) => a.id)]),
            eq(extractedItems.status, 'candidate'),
          ),
        );
      await audit(tx, actor, project, 'requirement.created', 'requirement', requirementId, {
        key,
        origin: 'source',
        itemId: id,
        snapshotId: item.snapshotId,
      });
      await appendOutbox(tx, {
        type: 'requirement.created',
        aggregateType: 'requirement',
        aggregateId: requirementId,
        projectId: project.id,
        payload: { key },
      });
      created.push({ itemId: id, requirementId, key });
    }
    return { created, skipped };
  });
}

/**
 * Splits a requirement candidate that holds several requirements (M04-FR-08) into new candidates
 * with the same location and confidence. Its criteria go with the first part; the original is
 * marked `replaced`. Parts may be edited text, so this is also the candidate editor.
 */
export async function splitCandidate(
  db: Db,
  actor: Principal,
  project: Project,
  itemId: string,
  rawParts: readonly string[],
): Promise<{ itemIds: string[] }> {
  assertProjectWritable(project);
  const parts = rawParts.map((p) => p.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 20 || parts.some((p) => p.length > 20_000))
    throw new DomainError('candidate.split_invalid');
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(extractedItems)
      .where(
        and(
          eq(extractedItems.id, itemId),
          eq(extractedItems.projectId, project.id),
          eq(extractedItems.kind, 'requirement'),
        ),
      )
      .for('update');
    if (!item) throw new DomainError('candidate.not_found');
    if (item.status !== 'candidate') throw new DomainError('candidate.not_a_candidate');
    if (parts.length === 1 && parts[0] === item.text.trim()) throw new DomainError('candidate.split_invalid');
    const now = new Date();
    const ids = parts.map(() => uuidv7());
    await tx.insert(extractedItems).values(
      parts.map((text, i) => ({
        id: ids[i]!,
        projectId: project.id,
        snapshotId: item.snapshotId,
        kind: 'requirement',
        text,
        locator: item.locator,
        language: item.language,
        confidence: item.confidence,
        method: 'manual',
        externalKey: i === 0 ? item.externalKey : null,
        rule: 'manual.split',
        status: 'candidate',
        createdAt: now,
      })),
    );
    await tx
      .update(extractedItems)
      .set({ parentItemId: ids[0]! })
      .where(and(eq(extractedItems.parentItemId, itemId), eq(extractedItems.status, 'candidate')));
    await tx.update(extractedItems).set({ status: 'replaced' }).where(eq(extractedItems.id, itemId));
    await audit(tx, actor, project, 'requirement.candidate.split', 'extracted_item', itemId, {
      snapshotId: item.snapshotId,
      parts: parts.length,
      itemIds: ids,
    });
    return { itemIds: ids };
  });
}

export interface MergeOutcome {
  readonly requirementId: string;
  readonly key: string;
  /** The new draft version when the candidate brought new criteria; null when only provenance was added. */
  readonly newVersion: number | null;
}

/**
 * Merges a requirement candidate into an existing requirement (M04-AC-10, BR-M04-9): the
 * requirement keeps every provenance and gains the candidate's. Criteria the requirement does not
 * have yet make a new draft version; otherwise the candidate only becomes a further provenance of
 * the latest version.
 */
export async function mergeCandidate(
  db: Db,
  actor: Principal,
  project: Project,
  itemId: string,
  requirementId: string,
): Promise<MergeOutcome> {
  assertProjectWritable(project);
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(extractedItems)
      .where(
        and(
          eq(extractedItems.id, itemId),
          eq(extractedItems.projectId, project.id),
          eq(extractedItems.kind, 'requirement'),
        ),
      )
      .for('update');
    if (!item) throw new DomainError('candidate.not_found');
    if (item.status !== 'candidate') throw new DomainError('candidate.not_a_candidate');
    const acs = await tx
      .select()
      .from(extractedItems)
      .where(and(eq(extractedItems.parentItemId, itemId), eq(extractedItems.status, 'candidate')))
      .orderBy(asc(extractedItems.id));
    const norm = (t: string) => normalizeForSearch(t);
    const r = await sourceDrivenVersion(
      tx,
      actor,
      project,
      requirementId,
      (latest) => {
        const have = new Set(latest.acceptanceCriteria.map((a) => norm(a.text)));
        const extra = acs.map((a) => a.text.slice(0, 5000)).filter((t) => !have.has(norm(t)));
        return {
          ...latest,
          acceptanceCriteria: [
            ...latest.acceptanceCriteria,
            ...extra.map((t) => ({ text: t, origin: 'source' as const })),
          ].slice(0, 100),
        };
      },
      (items) => [...items, itemId, ...acs.map((a) => a.id)],
    );
    if (r.outcome === 'skipped') {
      throw new DomainError(r.reason === 'in_review' ? 'requirement.in_review' : 'requirement.obsolete');
    }
    await tx
      .update(extractedItems)
      .set({ status: 'merged' })
      .where(
        and(
          inArray(extractedItems.id, [itemId, ...acs.map((a) => a.id)]),
          eq(extractedItems.status, 'candidate'),
        ),
      );
    const [req] = await tx
      .select({ key: requirements.key })
      .from(requirements)
      .where(eq(requirements.id, requirementId));
    const newVersion = r.outcome === 'created' ? r.version : null;
    if (newVersion !== null) {
      await flagForReview(
        tx,
        project,
        { type: 'requirement', ids: [requirementId] },
        { kind: 'merged_source', itemId, version: newVersion },
      );
      await appendOutbox(tx, {
        type: 'requirement.version.created',
        aggregateType: 'requirement',
        aggregateId: requirementId,
        projectId: project.id,
        payload: { version: newVersion, cause: 'merge', itemId },
      });
    }
    await audit(tx, actor, project, 'requirement.candidate.merged', 'requirement', requirementId, {
      key: req!.key,
      itemId,
      snapshotId: item.snapshotId,
      newVersion,
    });
    return { requirementId, key: req!.key, newVersion };
  });
}

/** Rejects requirement candidates (and their criteria). Already handled items are left alone. */
export async function rejectCandidates(
  db: Db,
  actor: Principal,
  project: Project,
  itemIds: readonly string[],
  reason: string,
): Promise<{ rejected: number }> {
  assertProjectWritable(project);
  const ids = [...new Set(itemIds)];
  if (!ids.length || ids.length > 500) throw new DomainError('candidates.count_invalid');
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(extractedItems)
      .set({ status: 'rejected' })
      .where(
        and(
          inArray(extractedItems.id, ids),
          eq(extractedItems.projectId, project.id),
          eq(extractedItems.kind, 'requirement'),
          eq(extractedItems.status, 'candidate'),
        ),
      )
      .returning({ id: extractedItems.id });
    if (rows.length) {
      await tx
        .update(extractedItems)
        .set({ status: 'rejected' })
        .where(
          and(
            inArray(
              extractedItems.parentItemId,
              rows.map((r) => r.id),
            ),
            eq(extractedItems.status, 'candidate'),
          ),
        );
      await audit(tx, actor, project, 'requirement.candidates.rejected', 'extracted_item', rows[0]!.id, {
        count: rows.length,
        itemIds: rows.map((r) => r.id).slice(0, 50),
        reason: reason.slice(0, 500),
      });
    }
    return { rejected: rows.length };
  });
}

// ---------- spreadsheet mapping (T-P3-07) ----------

async function parsedOf(deps: Pick<DocumentDeps, 'db' | 'storage'>, project: Project, snapshotId: string) {
  const [row] = await deps.db
    .select({
      key: parsedDocuments.storedObjectKey,
      sourceId: sourceSnapshots.sourceId,
      status: sourceSnapshots.parseStatus,
    })
    .from(sourceSnapshots)
    .leftJoin(parsedDocuments, eq(parsedDocuments.snapshotId, sourceSnapshots.id))
    .where(and(eq(sourceSnapshots.id, snapshotId), eq(sourceSnapshots.projectId, project.id)));
  if (!row) throw new DomainError('snapshot.not_found');
  if (row.status !== 'parsed' || !row.key) throw new DomainError('snapshot.not_parsed');
  const doc = JSON.parse(new TextDecoder().decode(await deps.storage.get(row.key))) as ParsedDocument;
  return { doc, sourceId: row.sourceId };
}

/** The parser output of a snapshot, for the source viewer (M04 §7 `/snapshots/{id}/parsed`). */
export async function getParsedDocument(
  deps: Pick<DocumentDeps, 'db' | 'storage'>,
  project: Project,
  snapshotId: string,
): Promise<ParsedDocument> {
  return (await parsedOf(deps, project, snapshotId)).doc;
}

export interface MappingPreview {
  readonly tables: { table: string; rows: number; header: string[]; suggested: ColumnMapping }[];
  readonly mapping: ColumnMapping | null;
  readonly requirements: number;
  readonly acceptanceCriteria: number;
  readonly sample: {
    text: string;
    externalKey: string | null;
    acceptanceCriteria: string[];
    locator: Record<string, unknown>;
  }[];
}

/** What a mapping would extract from a parsed sheet, without changing anything. */
export async function previewMapping(
  deps: Pick<DocumentDeps, 'db' | 'storage'>,
  project: Project,
  snapshotId: string,
  mapping: unknown,
): Promise<MappingPreview> {
  const { doc } = await parsedOf(deps, project, snapshotId);
  const m = mapping === undefined || mapping === null ? null : parseMapping(mapping);
  const c = extractCandidates(doc.blocks, m ? { mapping: m } : {});
  const reqIdx = c.flatMap((x, i) => (x.kind === 'requirement' ? [i] : []));
  return {
    tables: tableHeaders(doc.blocks),
    mapping: m,
    requirements: reqIdx.length,
    acceptanceCriteria: c.length - reqIdx.length,
    sample: reqIdx.slice(0, 20).map((i) => ({
      text: c[i]!.text,
      externalKey: c[i]!.externalKey,
      acceptanceCriteria: c.filter((x) => x.parent === i).map((x) => x.text),
      locator: { ...c[i]!.locator },
    })),
  };
}

/** Drops requirement candidates (and their criteria) whose text was already accepted or rejected. */
function withoutDecided(candidates: readonly Candidate[], decided: ReadonlySet<string>): Candidate[] {
  const keep = candidates.map((c) => c.kind !== 'requirement' || !decided.has(c.text.slice(0, 20_000)));
  const index = new Map<number, number>();
  const out: Candidate[] = [];
  candidates.forEach((c, i) => {
    if (!keep[i] || (c.parent !== null && !keep[c.parent])) return;
    index.set(i, out.length);
    out.push(c.parent === null ? c : { ...c, parent: index.get(c.parent)! });
  });
  return out;
}

/**
 * Re-runs extraction on a parsed snapshot with the source's saved mapping. Open candidates are
 * replaced; accepted and rejected ones stay as they are.
 */
export async function reextractSnapshot(
  deps: Pick<DocumentDeps, 'db' | 'storage'>,
  actor: Principal,
  project: Project,
  snapshotId: string,
): Promise<{ replaced: number; candidates: number }> {
  assertProjectWritable(project);
  const { doc, sourceId } = await parsedOf(deps, project, snapshotId);
  const source = await loadSource(deps.db, project, sourceId);
  const fresh = extractCandidates(doc.blocks, { mapping: mappingOf(source.config) });
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`qos:reextract:${snapshotId}`}))`);
    const decided = await tx
      .select({ text: extractedItems.text })
      .from(extractedItems)
      .where(
        and(
          eq(extractedItems.snapshotId, snapshotId),
          eq(extractedItems.kind, 'requirement'),
          inArray(extractedItems.status, ['accepted', 'rejected', 'merged']),
        ),
      );
    const candidates = withoutDecided(fresh, new Set(decided.map((d) => d.text)));
    const replaced = await tx
      .update(extractedItems)
      .set({ status: 'replaced' })
      .where(and(eq(extractedItems.snapshotId, snapshotId), eq(extractedItems.status, 'candidate')))
      .returning({ id: extractedItems.id });
    await insertCandidates(tx, project.id, snapshotId, candidates);
    await tx
      .update(sourceSnapshots)
      .set({ extractionQuality: qualityOf(doc, candidates) })
      .where(eq(sourceSnapshots.id, snapshotId));
    await audit(tx, actor, project, 'requirement.document.reextracted', 'source_snapshot', snapshotId, {
      replaced: replaced.length,
      candidates: candidates.length,
      mapped: mappingOf(source.config) !== undefined,
    });
    return { replaced: replaced.length, candidates: candidates.length };
  });
}
