import { createHash, randomUUID } from 'node:crypto';
import {
  acceptanceCriteria,
  and,
  appendAudit,
  desc,
  eq,
  extractedItems,
  inArray,
  requirementFindings,
  requirementProvenance,
  requirements,
  requirementSources,
  requirementVersions,
  sourceSnapshots,
  sql,
  type Db,
  type Tx,
} from '@qos/db';
import { decide, invalidateApprovals, requestApproval } from '@qos/governance';
import type { Principal } from '@qos/identity';
import { appendOutbox } from '@qos/jobs';
import { DomainError, uuidv7, type DomainEvent } from '@qos/kernel-domain';
import { assertProjectWritable, nextSequenceValue, type Project } from '@qos/projects';
import {
  canTransition,
  cleanContent,
  contentHash,
  normalizeForSearch,
  originOf,
  searchTextOf,
  type RequirementContent,
  type VersionState,
} from './domain.js';

/**
 * Requirements (M04, T-P3-01/02/03/09/13): sources, canonical requirements with immutable
 * versions, the approval workflow and search. Every function takes the project (ProjectScope).
 */
export const SOURCE_KINDS = ['external', 'document_set', 'spreadsheet', 'manual'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
const TARGET = 'requirement_version';

// ---------- sources ----------

export interface SourceView {
  readonly id: string;
  readonly kind: SourceKind;
  readonly name: string;
  readonly bindingId: string | null;
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly createdAt: string;
}
const sourceView = (r: typeof requirementSources.$inferSelect): SourceView => ({
  id: r.id,
  kind: r.kind as SourceKind,
  name: r.name,
  bindingId: r.bindingId,
  config: r.config as Record<string, unknown>,
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
});

export async function listSources(db: Db, project: Project): Promise<SourceView[]> {
  const rows = await db
    .select()
    .from(requirementSources)
    .where(eq(requirementSources.projectId, project.id))
    .orderBy(requirementSources.name);
  return rows.map(sourceView);
}

export async function createSource(
  db: Db,
  actor: Principal,
  project: Project,
  input: { kind: string; name: string; bindingId?: string | null; config?: Record<string, unknown> },
): Promise<SourceView> {
  assertProjectWritable(project);
  if (!(SOURCE_KINDS as readonly string[]).includes(input.kind))
    throw new DomainError('requirement_source.kind_invalid');
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new DomainError('requirement_source.name_invalid');
  if (input.kind === 'external' && !input.bindingId)
    throw new DomainError('requirement_source.binding_required');
  const config = input.config ?? {};
  if (JSON.stringify(config).length > 16_384) throw new DomainError('requirement_source.config_too_large');
  return db.transaction(async (tx) => {
    const now = new Date();
    const id = uuidv7();
    const inserted = await tx
      .insert(requirementSources)
      .values({
        id,
        projectId: project.id,
        kind: input.kind,
        name,
        bindingId: input.bindingId ?? null,
        config,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) throw new DomainError('requirement_source.name_taken');
    await audit(tx, actor, project, 'requirement_source.created', 'requirement_source', id, {
      kind: input.kind,
      name,
    });
    return sourceView(inserted[0]!);
  });
}

export async function updateSource(
  db: Db,
  actor: Principal,
  project: Project,
  sourceId: string,
  input: { name?: string; enabled?: boolean; config?: Record<string, unknown> },
): Promise<SourceView> {
  assertProjectWritable(project);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(requirementSources)
      .where(and(eq(requirementSources.id, sourceId), eq(requirementSources.projectId, project.id)))
      .for('update');
    if (!row) throw new DomainError('requirement_source.not_found');
    const set: Partial<typeof requirementSources.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length < 2 || name.length > 120) throw new DomainError('requirement_source.name_invalid');
      set.name = name;
    }
    if (input.enabled !== undefined) set.enabled = input.enabled;
    if (input.config !== undefined) set.config = input.config;
    const [updated] = await tx
      .update(requirementSources)
      .set(set)
      .where(eq(requirementSources.id, sourceId))
      .returning();
    await audit(tx, actor, project, 'requirement_source.updated', 'requirement_source', sourceId, {
      changed: Object.keys(input),
    });
    return sourceView(updated!);
  });
}

/** The project's manual source, created on first use. */
async function manualSource(tx: Tx, actor: Principal, project: Project): Promise<string> {
  const [existing] = await tx
    .select({ id: requirementSources.id })
    .from(requirementSources)
    .where(and(eq(requirementSources.projectId, project.id), eq(requirementSources.kind, 'manual')))
    .orderBy(requirementSources.createdAt)
    .limit(1);
  if (existing) return existing.id;
  const now = new Date();
  const id = uuidv7();
  await tx
    .insert(requirementSources)
    .values({
      id,
      projectId: project.id,
      kind: 'manual',
      name: 'Manual entries',
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: requirementSources.id })
    .from(requirementSources)
    .where(and(eq(requirementSources.projectId, project.id), eq(requirementSources.name, 'Manual entries')));
  return row!.id;
}

/** A manual snapshot + extracted item: the provenance of a human-written version (BR-M04-3). */
async function manualProvenance(
  tx: Tx,
  actor: Principal,
  project: Project,
  text: string,
  kind: 'entry' | 'edit',
): Promise<string> {
  const sourceId = await manualSource(tx, actor, project);
  const now = new Date();
  const snapshotId = uuidv7();
  await tx.insert(sourceSnapshots).values({
    id: snapshotId,
    projectId: project.id,
    sourceId,
    checksum: createHash('sha256').update(`${randomUUID()}:${text}`).digest('hex'),
    capturedBy: actor.userId,
    capturedAt: now,
    parseStatus: 'not_needed',
  });
  const itemId = uuidv7();
  await tx.insert(extractedItems).values({
    id: itemId,
    projectId: project.id,
    snapshotId,
    kind: 'requirement',
    text: text.slice(0, 2000),
    locator: { manual: kind, author: actor.userId, at: now.toISOString() },
    confidence: '1.000',
    method: 'manual',
    status: 'accepted',
    createdAt: now,
  });
  return itemId;
}

// ---------- requirements ----------

export interface VersionView {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly bodyMd: string;
  readonly priority: string | null;
  readonly tags: string[];
  readonly origin: string;
  readonly state: VersionState;
  readonly contentHash: string;
  readonly acceptanceCriteria: { ordinal: number; text: string; origin: string }[];
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly approvedAt: string | null;
  readonly approvalRequestId: string | null;
}
export interface ProvenanceView {
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly sourceName: string;
  readonly snapshotId: string;
  readonly itemId: string;
  readonly method: string;
  readonly locator: Record<string, unknown>;
  readonly capturedAt: string;
}
export interface RequirementSummary {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly state: VersionState;
  readonly effectiveVersion: number | null;
  readonly latestVersion: number;
  readonly priority: string | null;
  readonly tags: string[];
  readonly origin: string;
  readonly sourceKinds: string[];
  readonly sourceRemoved: boolean;
  readonly divergedFromSource: boolean;
  readonly openFindings: number;
  readonly updatedAt: string;
}
export interface RequirementDetail extends RequirementSummary {
  readonly versions: VersionView[];
  readonly provenance: ProvenanceView[];
  readonly findings: FindingView[];
}

async function versionView(db: Db | Tx, v: typeof requirementVersions.$inferSelect): Promise<VersionView> {
  const acs = await db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.requirementVersionId, v.id))
    .orderBy(acceptanceCriteria.ordinal);
  return {
    id: v.id,
    number: v.number,
    title: v.title,
    bodyMd: v.bodyMd,
    priority: v.priority,
    tags: v.tags,
    origin: v.origin,
    state: v.state as VersionState,
    contentHash: v.contentHash,
    acceptanceCriteria: acs.map((a) => ({ ordinal: a.ordinal, text: a.text, origin: a.origin })),
    createdAt: v.createdAt.toISOString(),
    submittedAt: v.submittedAt?.toISOString() ?? null,
    approvedAt: v.approvedAt?.toISOString() ?? null,
    approvalRequestId: v.approvalRequestId,
  };
}

/** Inserts a version with its criteria and provenance; updates the requirement's latest pointer. */
async function insertVersion(
  tx: Tx,
  actor: Principal,
  project: Project,
  requirementId: string,
  number: number,
  content: RequirementContent,
  origin: string,
  provenanceItemIds: readonly string[],
): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await tx.insert(requirementVersions).values({
    id,
    requirementId,
    projectId: project.id,
    number,
    title: content.title,
    bodyMd: content.bodyMd,
    priority: content.priority,
    tags: [...content.tags],
    origin,
    state: 'draft',
    contentHash: contentHash(content),
    searchText: searchTextOf(content),
    createdBy: actor.userId,
    createdAt: now,
  });
  if (content.acceptanceCriteria.length) {
    await tx.insert(acceptanceCriteria).values(
      content.acceptanceCriteria.map((a, i) => ({
        id: uuidv7(),
        requirementVersionId: id,
        ordinal: i + 1,
        text: a.text,
        origin: a.origin,
      })),
    );
  }
  for (const itemId of new Set(provenanceItemIds)) {
    await tx
      .insert(requirementProvenance)
      .values({ requirementVersionId: id, extractedItemId: itemId })
      .onConflictDoNothing();
  }
  await tx
    .update(requirements)
    .set({ latestVersionId: id, updatedAt: now })
    .where(eq(requirements.id, requirementId));
  return id;
}

function clean(input: RequirementContent): RequirementContent {
  try {
    return cleanContent(input);
  } catch (e) {
    throw new DomainError((e as Error).message);
  }
}

/** Manual entry (M04-FR-07): a new requirement `PRJ-R-n` with version 1 as a draft. */
export async function createManualRequirement(
  db: Db,
  actor: Principal,
  project: Project,
  input: RequirementContent,
): Promise<RequirementDetail> {
  assertProjectWritable(project);
  const content = clean(input);
  const id = await db.transaction(async (tx) => {
    const n = await nextSequenceValue(tx, project.id, 'requirement');
    const key = `${project.key}-R-${n}`;
    const id = uuidv7();
    const now = new Date();
    await tx.insert(requirements).values({ id, projectId: project.id, key, createdAt: now, updatedAt: now });
    const itemId = await manualProvenance(tx, actor, project, content.title, 'entry');
    await insertVersion(tx, actor, project, id, 1, content, originOf('manual', content), [itemId]);
    await audit(tx, actor, project, 'requirement.created', 'requirement', id, { key, origin: 'manual' });
    await appendOutbox(tx, {
      type: 'requirement.created',
      aggregateType: 'requirement',
      aggregateId: id,
      projectId: project.id,
      payload: { key },
    });
    return id;
  });
  return getRequirement(db, project, id);
}

async function lockRequirement(tx: Tx, project: Project, requirementId: string) {
  const [req] = await tx
    .select()
    .from(requirements)
    .where(and(eq(requirements.id, requirementId), eq(requirements.projectId, project.id)))
    .for('update');
  if (!req) throw new DomainError('requirement.not_found');
  return req;
}

/**
 * An edit creates a new draft version (M04-FR-11, BR-M04-2). The approved version stays
 * effective. Unapproved older drafts are superseded; a version in review must be withdrawn first.
 * Editing a requirement that came from an external source marks it diverged (BR-M04-8).
 */
export async function editRequirement(
  db: Db,
  actor: Principal,
  project: Project,
  requirementId: string,
  input: RequirementContent & { expectedLatestVersion: number },
): Promise<RequirementDetail> {
  assertProjectWritable(project);
  const content = clean(input);
  await db.transaction(async (tx) => {
    const req = await lockRequirement(tx, project, requirementId);
    const [latest] = await tx
      .select()
      .from(requirementVersions)
      .where(eq(requirementVersions.id, req.latestVersionId!));
    if (!latest) throw new DomainError('requirement.not_found');
    if (latest.number !== input.expectedLatestVersion) {
      throw new DomainError('requirement.version_conflict', { latestVersion: latest.number });
    }
    if (latest.state === 'in_review') throw new DomainError('requirement.in_review');
    if (latest.state === 'obsolete') throw new DomainError('requirement.obsolete');
    if (contentHash(content) === latest.contentHash) return;
    const previousItems = await tx
      .select({ id: requirementProvenance.extractedItemId, kind: requirementSources.kind })
      .from(requirementProvenance)
      .innerJoin(extractedItems, eq(extractedItems.id, requirementProvenance.extractedItemId))
      .innerJoin(sourceSnapshots, eq(sourceSnapshots.id, extractedItems.snapshotId))
      .innerJoin(requirementSources, eq(requirementSources.id, sourceSnapshots.sourceId))
      .where(eq(requirementProvenance.requirementVersionId, latest.id));
    const fromExternal = previousItems.some((p) => p.kind !== 'manual');
    const editItem = await manualProvenance(tx, actor, project, content.title, 'edit');
    if (latest.state === 'draft' || latest.state === 'rejected') {
      await tx
        .update(requirementVersions)
        .set({ state: 'superseded' })
        .where(eq(requirementVersions.id, latest.id));
    }
    const base = latest.origin === 'manual' ? 'manual' : 'source';
    const origin = fromExternal || latest.origin === 'mixed' ? 'mixed' : originOf(base, content);
    await insertVersion(tx, actor, project, requirementId, latest.number + 1, content, origin, [
      ...previousItems.map((p) => p.id),
      editItem,
    ]);
    if (fromExternal)
      await tx
        .update(requirements)
        .set({ divergedFromSource: true })
        .where(eq(requirements.id, requirementId));
    await audit(tx, actor, project, 'requirement.edited', 'requirement', requirementId, {
      key: req.key,
      version: latest.number + 1,
      divergedFromSource: fromExternal,
    });
    await appendOutbox(tx, {
      type: 'requirement.version.created',
      aggregateType: 'requirement',
      aggregateId: requirementId,
      projectId: project.id,
      payload: { version: latest.number + 1 },
    });
  });
  return getRequirement(db, project, requirementId);
}

async function openConflicts(
  db: Db | Tx,
  project: Project,
  requirementIds: readonly string[],
): Promise<string[]> {
  if (!requirementIds.length) return [];
  const rows = await db
    .select({ id: requirementFindings.id })
    .from(requirementFindings)
    .where(
      and(
        eq(requirementFindings.projectId, project.id),
        eq(requirementFindings.type, 'conflict'),
        eq(requirementFindings.status, 'open'),
        sql`${requirementFindings.subjectIds} && array[${sql.join(
          requirementIds.map((i) => sql`${i}`),
          sql`, `,
        )}]::uuid[]`,
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Submits the latest draft for approval: state `in_review` and an approval request bound to the
 * version's content hash. Refused while a conflict finding is open (BR-M04-6, M04-AC-05).
 */
export async function submitForApproval(
  db: Db,
  actor: Principal,
  project: Project,
  requirementId: string,
): Promise<RequirementDetail> {
  assertProjectWritable(project);
  await db.transaction(async (tx) => {
    const req = await lockRequirement(tx, project, requirementId);
    const [latest] = await tx
      .select()
      .from(requirementVersions)
      .where(eq(requirementVersions.id, req.latestVersionId!));
    if (!latest || latest.state !== 'draft') throw new DomainError('requirement.not_draft');
    const conflicts = await openConflicts(tx, project, [requirementId]);
    if (conflicts.length)
      throw new DomainError('requirement.open_conflict', { findings: conflicts.join(',') });
    const request = await requestApproval(tx, actor, {
      projectId: project.id,
      action: 'requirement.approve',
      targetType: TARGET,
      targetId: latest.id,
      contentHash: latest.contentHash,
    });
    await tx
      .update(requirementVersions)
      .set({ state: 'in_review', submittedAt: new Date(), approvalRequestId: request.id })
      .where(and(eq(requirementVersions.id, latest.id), eq(requirementVersions.state, 'draft')));
    await audit(tx, actor, project, 'requirement.submitted', 'requirement', requirementId, {
      key: req.key,
      version: latest.number,
      approvalRequestId: request.id,
    });
  });
  return getRequirement(db, project, requirementId);
}

/** Takes a version out of review (back to draft) and invalidates its pending approval. */
export async function withdrawFromReview(
  db: Db,
  actor: Principal,
  project: Project,
  requirementId: string,
): Promise<RequirementDetail> {
  await db.transaction(async (tx) => {
    const req = await lockRequirement(tx, project, requirementId);
    await withdrawIn(tx, project, req.latestVersionId!);
    await audit(tx, actor, project, 'requirement.withdrawn', 'requirement', requirementId, { key: req.key });
  });
  return getRequirement(db, project, requirementId);
}

async function withdrawIn(tx: Tx, project: Project, versionId: string): Promise<boolean> {
  const moved = await tx
    .update(requirementVersions)
    .set({ state: 'draft', submittedAt: null, approvalRequestId: null })
    .where(and(eq(requirementVersions.id, versionId), eq(requirementVersions.state, 'in_review')))
    .returning({ id: requirementVersions.id });
  if (moved.length) await invalidateApprovals(tx, project.id, TARGET, versionId, 'withdrawn');
  return moved.length === 1;
}

/**
 * Applies an approval decision to the version it targets. Idempotent (expected-state updates),
 * so it is safe to call right after a decision and again from the `approval.decided` event.
 */
export async function applyApprovalOutcome(
  tx: Tx,
  input: { targetId: string; status: string },
): Promise<'approved' | 'rejected' | 'reopened' | 'noop'> {
  const [v] = await tx
    .select()
    .from(requirementVersions)
    .where(eq(requirementVersions.id, input.targetId))
    .for('update');
  if (!v || v.state !== 'in_review') return 'noop';
  const now = new Date();
  if (input.status === 'approved') {
    const [req] = await tx
      .select()
      .from(requirements)
      .where(eq(requirements.id, v.requirementId))
      .for('update');
    if (req?.effectiveVersionId && req.effectiveVersionId !== v.id) {
      await tx
        .update(requirementVersions)
        .set({ state: 'superseded' })
        .where(
          and(eq(requirementVersions.id, req.effectiveVersionId), eq(requirementVersions.state, 'approved')),
        );
    }
    await tx
      .update(requirementVersions)
      .set({ state: 'approved', approvedAt: now })
      .where(eq(requirementVersions.id, v.id));
    await tx
      .update(requirements)
      .set({ effectiveVersionId: v.id, updatedAt: now })
      .where(eq(requirements.id, v.requirementId));
    await appendOutbox(tx, {
      type: 'requirement.approved',
      aggregateType: 'requirement',
      aggregateId: v.requirementId,
      projectId: v.projectId,
      payload: { version: v.number },
    });
    return 'approved';
  }
  if (input.status === 'rejected') {
    await tx.update(requirementVersions).set({ state: 'rejected' }).where(eq(requirementVersions.id, v.id));
    return 'rejected';
  }
  if (input.status === 'expired' || input.status === 'invalidated') {
    await tx
      .update(requirementVersions)
      .set({ state: 'draft', submittedAt: null, approvalRequestId: null })
      .where(eq(requirementVersions.id, v.id));
    return 'reopened';
  }
  return 'noop';
}

/** Outbox subscriber: decisions made from the generic approvals inbox reach requirements here. */
export async function onApprovalDecided(event: DomainEvent<Record<string, unknown>>, tx: Tx): Promise<void> {
  const p = event.payload;
  if (p.targetType !== TARGET || typeof p.targetId !== 'string' || typeof p.status !== 'string') return;
  await applyApprovalOutcome(tx, { targetId: p.targetId, status: p.status });
}

/**
 * Approves several versions in review (one decision each). Items with inferred acceptance
 * criteria need `includesInferred` (BR-M04-1, M04-AC-02); the flag is recorded in the audit.
 */
export async function bulkApprove(
  db: Db,
  actor: Principal,
  project: Project,
  input: { requirementIds: readonly string[]; includesInferred: boolean; comment?: string | null },
): Promise<{ approved: string[]; pending: string[] }> {
  if (!input.requirementIds.length || input.requirementIds.length > 200)
    throw new DomainError('requirement.bulk_size');
  const rows = await db
    .select({ req: requirements, version: requirementVersions })
    .from(requirements)
    .innerJoin(requirementVersions, eq(requirementVersions.id, requirements.latestVersionId))
    .where(and(eq(requirements.projectId, project.id), inArray(requirements.id, [...input.requirementIds])));
  if (rows.length !== new Set(input.requirementIds).size) throw new DomainError('requirement.not_found');
  const notInReview = rows.filter((r) => r.version.state !== 'in_review' || !r.version.approvalRequestId);
  if (notInReview.length)
    throw new DomainError('requirement.not_in_review', { keys: notInReview.map((r) => r.req.key).join(',') });
  const inferred = await db
    .select({ versionId: acceptanceCriteria.requirementVersionId })
    .from(acceptanceCriteria)
    .where(
      and(
        inArray(
          acceptanceCriteria.requirementVersionId,
          rows.map((r) => r.version.id),
        ),
        eq(acceptanceCriteria.origin, 'inferred'),
      ),
    );
  const withInferred = new Set(inferred.map((i) => i.versionId));
  if (withInferred.size && !input.includesInferred) {
    throw new DomainError('requirement.inferred_confirmation_required', {
      keys: rows
        .filter((r) => withInferred.has(r.version.id))
        .map((r) => r.req.key)
        .join(','),
    });
  }
  const conflicts = await openConflicts(
    db,
    project,
    rows.map((r) => r.req.id),
  );
  if (conflicts.length) throw new DomainError('requirement.open_conflict', { findings: conflicts.join(',') });
  const approved: string[] = [];
  const pending: string[] = [];
  for (const r of rows) {
    const result = await decide(db, actor, {
      requestId: r.version.approvalRequestId!,
      decision: 'approve',
      comment: input.comment ?? null,
    });
    if (result.status === 'approved') {
      await db.transaction((tx) => applyApprovalOutcome(tx, { targetId: r.version.id, status: 'approved' }));
      approved.push(r.req.key);
    } else pending.push(r.req.key);
  }
  await db.transaction((tx) =>
    audit(tx, actor, project, 'requirement.bulk_approved', 'project', project.id, {
      keys: rows.map((r) => r.req.key),
      includesInferred: input.includesInferred,
      inferredItems: rows.filter((r) => withInferred.has(r.version.id)).map((r) => r.req.key),
    }),
  );
  return { approved, pending };
}

/** Single decision from the requirements screen; applies an approval right away. */
export async function decideRequirement(
  db: Db,
  actor: Principal,
  project: Project,
  requirementId: string,
  input: { decision: 'approve' | 'reject'; comment?: string | null },
): Promise<RequirementDetail> {
  const [row] = await db
    .select({ version: requirementVersions })
    .from(requirements)
    .innerJoin(requirementVersions, eq(requirementVersions.id, requirements.latestVersionId))
    .where(and(eq(requirements.id, requirementId), eq(requirements.projectId, project.id)));
  if (!row) throw new DomainError('requirement.not_found');
  if (row.version.state !== 'in_review' || !row.version.approvalRequestId)
    throw new DomainError('requirement.not_in_review');
  if (input.decision === 'approve' && (await openConflicts(db, project, [requirementId])).length) {
    throw new DomainError('requirement.open_conflict');
  }
  const result = await decide(db, actor, {
    requestId: row.version.approvalRequestId,
    decision: input.decision,
    comment: input.comment ?? null,
  });
  if (result.status === 'approved' || result.status === 'rejected') {
    await db.transaction((tx) =>
      applyApprovalOutcome(tx, { targetId: row.version.id, status: result.status }),
    );
  }
  return getRequirement(db, project, requirementId);
}

/** Withdraws an approved requirement (M04-FR-10). Only by a person (BR-M04-5). */
export async function markObsolete(
  db: Db,
  actor: Principal,
  project: Project,
  requirementId: string,
  reason: string,
): Promise<RequirementDetail> {
  assertProjectWritable(project);
  const why = reason.trim();
  if (why.length < 3 || why.length > 500) throw new DomainError('requirement.reason_required');
  await db.transaction(async (tx) => {
    const req = await lockRequirement(tx, project, requirementId);
    const versions = await tx
      .select()
      .from(requirementVersions)
      .where(
        and(
          eq(requirementVersions.requirementId, requirementId),
          inArray(requirementVersions.state, ['draft', 'in_review', 'approved']),
        ),
      );
    if (!versions.length) throw new DomainError('requirement.obsolete');
    for (const v of versions) {
      if (v.state === 'in_review') await withdrawIn(tx, project, v.id);
      if (canTransition(v.state === 'in_review' ? 'draft' : (v.state as VersionState), 'obsolete')) {
        await tx
          .update(requirementVersions)
          .set({ state: 'obsolete' })
          .where(eq(requirementVersions.id, v.id));
      }
    }
    await audit(tx, actor, project, 'requirement.obsoleted', 'requirement', requirementId, {
      key: req.key,
      reason: why,
    });
    await appendOutbox(tx, {
      type: 'requirement.obsoleted',
      aggregateType: 'requirement',
      aggregateId: requirementId,
      projectId: project.id,
      payload: {},
    });
  });
  return getRequirement(db, project, requirementId);
}

// ---------- findings (conflicts; AI analysis arrives in P5) ----------

export interface FindingView {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly subjectIds: string[];
  readonly detail: Record<string, unknown>;
  readonly resolution: Record<string, unknown> | null;
  readonly createdAt: string;
}
const findingView = (f: typeof requirementFindings.$inferSelect): FindingView => ({
  id: f.id,
  type: f.type,
  status: f.status,
  subjectIds: f.subjectIds,
  detail: f.detail as Record<string, unknown>,
  resolution: f.resolution as Record<string, unknown> | null,
  createdAt: f.createdAt.toISOString(),
});

/**
 * Records a conflict between requirements. Any of them in review goes back to draft, so a
 * conflicting text cannot be approved meanwhile (BR-M04-6).
 */
export async function reportConflict(
  db: Db,
  actor: Principal,
  project: Project,
  input: { requirementIds: readonly string[]; note: string },
): Promise<FindingView> {
  assertProjectWritable(project);
  const ids = [...new Set(input.requirementIds)];
  if (ids.length < 2 || ids.length > 10) throw new DomainError('finding.subjects_invalid');
  const note = input.note.trim().slice(0, 2000);
  return db.transaction(async (tx) => {
    const reqs = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.projectId, project.id), inArray(requirements.id, ids)));
    if (reqs.length !== ids.length) throw new DomainError('requirement.not_found');
    for (const r of reqs) if (r.latestVersionId) await withdrawIn(tx, project, r.latestVersionId);
    const id = uuidv7();
    const [row] = await tx
      .insert(requirementFindings)
      .values({
        id,
        projectId: project.id,
        type: 'conflict',
        status: 'open',
        subjectIds: ids,
        detail: { note, keys: reqs.map((r) => r.key) },
        createdBy: actor.userId,
        createdAt: new Date(),
      })
      .returning();
    await audit(tx, actor, project, 'requirement.finding.created', 'finding', id, {
      type: 'conflict',
      keys: reqs.map((r) => r.key),
    });
    return findingView(row!);
  });
}

/** Resolves (`finding.resolve`) or waives (`finding.waive`, qa_lead) a finding with a reason. */
export async function closeFinding(
  db: Db,
  actor: Principal,
  project: Project,
  findingId: string,
  input: { status: 'resolved' | 'waived' | 'dismissed'; reason: string },
): Promise<FindingView> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new DomainError('finding.reason_required');
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(requirementFindings)
      .set({ status: input.status, resolution: { reason }, resolvedBy: actor.userId, resolvedAt: now })
      .where(
        and(
          eq(requirementFindings.id, findingId),
          eq(requirementFindings.projectId, project.id),
          eq(requirementFindings.status, 'open'),
        ),
      )
      .returning();
    if (!row) {
      const [exists] = await tx
        .select({ id: requirementFindings.id })
        .from(requirementFindings)
        .where(and(eq(requirementFindings.id, findingId), eq(requirementFindings.projectId, project.id)));
      // Another project's finding looks like an unknown one (no existence leak).
      throw new DomainError(exists ? 'finding.not_open' : 'finding.not_found');
    }
    await audit(tx, actor, project, `requirement.finding.${input.status}`, 'finding', findingId, { reason });
    return findingView(row);
  });
}

export async function listFindings(
  db: Db,
  project: Project,
  opts: { status?: string } = {},
): Promise<FindingView[]> {
  const rows = await db
    .select()
    .from(requirementFindings)
    .where(
      opts.status
        ? and(eq(requirementFindings.projectId, project.id), eq(requirementFindings.status, opts.status))
        : eq(requirementFindings.projectId, project.id),
    )
    .orderBy(desc(requirementFindings.createdAt));
  return rows.map(findingView);
}

// ---------- reading and search ----------

/**
 * Lists requirements with their latest version. `q` is matched on the Arabic-normalized text
 * (substring through the trigram index, so "الدخول" finds "الدُّخول"; M04-AC-06).
 */
export async function listRequirements(
  db: Db,
  project: Project,
  opts: { q?: string; state?: string; sourceId?: string; limit?: number } = {},
): Promise<RequirementSummary[]> {
  const conds = [eq(requirements.projectId, project.id)];
  const q = opts.q ? normalizeForSearch(opts.q) : '';
  if (q) conds.push(sql`${requirementVersions.searchText} like ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'}`);
  if (opts.state) conds.push(eq(requirementVersions.state, opts.state));
  if (opts.sourceId) {
    conds.push(sql`exists (select 1 from requirements.requirement_provenance rp
      join requirements.extracted_items ei on ei.id = rp.extracted_item_id
      join requirements.source_snapshots ss on ss.id = ei.snapshot_id
      where rp.requirement_version_id = ${requirementVersions.id} and ss.source_id = ${opts.sourceId})`);
  }
  const rows = await db
    .select({ req: requirements, version: requirementVersions })
    .from(requirements)
    .innerJoin(requirementVersions, eq(requirementVersions.id, requirements.latestVersionId))
    .where(and(...conds))
    .orderBy(desc(requirements.updatedAt))
    .limit(Math.min(opts.limit ?? 200, 500));
  return Promise.all(rows.map((r) => summarize(db, project, r.req, r.version)));
}

async function summarize(
  db: Db | Tx,
  project: Project,
  req: typeof requirements.$inferSelect,
  latest: typeof requirementVersions.$inferSelect,
): Promise<RequirementSummary> {
  const [effective] = req.effectiveVersionId
    ? await db
        .select({ number: requirementVersions.number })
        .from(requirementVersions)
        .where(eq(requirementVersions.id, req.effectiveVersionId))
    : [];
  const kinds = await db.execute<{ kind: string }>(sql`
    select distinct s.kind from requirements.requirement_provenance rp
    join requirements.extracted_items ei on ei.id = rp.extracted_item_id
    join requirements.source_snapshots ss on ss.id = ei.snapshot_id
    join requirements.requirement_sources s on s.id = ss.source_id
    where rp.requirement_version_id = ${latest.id} order by 1`);
  const open = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from requirements.requirement_findings
    where project_id = ${project.id} and status = 'open' and ${req.id}::uuid = any(subject_ids)`);
  return {
    id: req.id,
    key: req.key,
    title: latest.title,
    state: latest.state as VersionState,
    effectiveVersion: effective?.number ?? null,
    latestVersion: latest.number,
    priority: latest.priority,
    tags: latest.tags,
    origin: latest.origin,
    sourceKinds: kinds.rows.map((k) => k.kind),
    sourceRemoved: req.sourceRemoved,
    divergedFromSource: req.divergedFromSource,
    openFindings: open.rows[0]?.n ?? 0,
    updatedAt: req.updatedAt.toISOString(),
  };
}

export async function findRequirementByKey(db: Db, project: Project, key: string): Promise<string | null> {
  const [row] = await db
    .select({ id: requirements.id })
    .from(requirements)
    .where(and(eq(requirements.projectId, project.id), eq(requirements.key, key)));
  return row?.id ?? null;
}

export async function getRequirement(
  db: Db,
  project: Project,
  requirementId: string,
): Promise<RequirementDetail> {
  const [req] = await db
    .select()
    .from(requirements)
    .where(and(eq(requirements.id, requirementId), eq(requirements.projectId, project.id)));
  if (!req || !req.latestVersionId) throw new DomainError('requirement.not_found');
  const versions = await db
    .select()
    .from(requirementVersions)
    .where(eq(requirementVersions.requirementId, requirementId))
    .orderBy(desc(requirementVersions.number));
  const latest = versions.find((v) => v.id === req.latestVersionId)!;
  const provenance = await db.execute<{
    source_id: string;
    source_kind: string;
    source_name: string;
    snapshot_id: string;
    item_id: string;
    method: string;
    locator: Record<string, unknown>;
    captured_at: Date;
  }>(sql`
    select s.id as source_id, s.kind as source_kind, s.name as source_name, ss.id as snapshot_id,
           ei.id as item_id, ei.method, ei.locator, ss.captured_at
    from requirements.requirement_provenance rp
    join requirements.extracted_items ei on ei.id = rp.extracted_item_id
    join requirements.source_snapshots ss on ss.id = ei.snapshot_id
    join requirements.requirement_sources s on s.id = ss.source_id
    where rp.requirement_version_id = ${latest.id}
    order by ss.captured_at`);
  const findings = await db
    .select()
    .from(requirementFindings)
    .where(
      and(
        eq(requirementFindings.projectId, project.id),
        sql`${requirementId}::uuid = any(${requirementFindings.subjectIds})`,
      ),
    )
    .orderBy(desc(requirementFindings.createdAt));
  return {
    ...(await summarize(db, project, req, latest)),
    versions: await Promise.all(versions.map((v) => versionView(db, v))),
    provenance: provenance.rows.map((p) => ({
      sourceId: p.source_id,
      sourceKind: p.source_kind,
      sourceName: p.source_name,
      snapshotId: p.snapshot_id,
      itemId: p.item_id,
      method: p.method,
      locator: p.locator,
      capturedAt: new Date(p.captured_at).toISOString(),
    })),
    findings: findings.map(findingView),
  };
}

async function audit(
  tx: Tx,
  actor: Principal,
  project: Project,
  action: string,
  targetType: string,
  targetId: string,
  summary: Record<string, unknown>,
) {
  await appendAudit(tx, {
    orgId: actor.orgId,
    projectId: project.id,
    actorType: 'user',
    actorId: actor.userId,
    action,
    targetType,
    targetId,
    summary,
    source: 'api',
  });
}
