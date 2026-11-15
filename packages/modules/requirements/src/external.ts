import { createHash } from 'node:crypto';
import {
  and,
  appendAudit,
  eq,
  extractedItems,
  inArray,
  projectBindings,
  projects,
  requirements,
  requirementSources,
  sourceSnapshots,
  type Tx,
} from '@qos/db';
import { getExternalRef, REQUIREMENT_ITEM_CHANGED } from '@qos/integrations';
import { appendOutbox } from '@qos/jobs';
import { uuidv7, type DomainEvent } from '@qos/kernel-domain';
import { findProjectById, nextSequenceValue, type Project } from '@qos/projects';
import { flagForReview } from '@qos/traceability';
import { normalizeForSearch, originOf, type RequirementContent } from './domain.js';
import { clean, insertVersion, requirementsOfItems, sourceDrivenVersion } from './shared.js';

/**
 * External requirement sources (T-P3-10, M04-AC-01/03): a work item synced from a tracker
 * (integrations stream `requirements.items`) becomes a requirement. The tracker is the authority
 * for the text (BR-M04-8): a new item creates a draft requirement; a new revision of a known item
 * creates a new draft version and the approved version stays effective (BR-M04-4); tests linked to
 * it are flagged for review; an item removed at the source marks the requirement (BR-M04-5).
 *
 * Idempotent (at-least-once delivery): one snapshot per item revision (unique checksum), and an
 * event whose revision is no longer the stored one is left to the event of the newer revision.
 */
export { REQUIREMENT_ITEM_CHANGED };
const ACTOR_ID = 'requirements.sync';

interface ItemSnapshot {
  type?: string;
  title?: string;
  descriptionMarkdown?: string;
  acceptanceCriteriaMarkdown?: string | null;
  state?: string;
  removed?: boolean;
  tags?: string[];
  changedAt?: string;
  revision?: string;
}

/** Acceptance criteria text split into criteria: one per list item or line. */
export function splitCriteria(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  return markdown
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/, '').trim())
    .filter((l) => l.length > 1)
    .map((l) => l.slice(0, 5000))
    .slice(0, 100);
}

export function contentFromItem(externalId: string, s: ItemSnapshot): RequirementContent {
  const title = (s.title ?? '').trim() || `Work item ${externalId}`;
  return {
    title: `${externalId}: ${title}`.slice(0, 300),
    bodyMd: (s.descriptionMarkdown ?? '').slice(0, 100_000),
    priority: null,
    tags: (s.tags ?? [])
      .map((t) => t.slice(0, 40))
      .filter(Boolean)
      .slice(0, 30),
    acceptanceCriteria: splitCriteria(s.acceptanceCriteriaMarkdown).map((text) => ({
      text,
      origin: 'source' as const,
    })),
  };
}

async function externalSource(tx: Tx, project: Project, bindingId: string): Promise<string> {
  const [found] = await tx
    .select({ id: requirementSources.id })
    .from(requirementSources)
    .where(
      and(
        eq(requirementSources.projectId, project.id),
        eq(requirementSources.kind, 'external'),
        eq(requirementSources.bindingId, bindingId),
      ),
    );
  if (found) return found.id;
  // First item of this binding: the source is created on the way (named, unique per project),
  // on behalf of the person who bound the tracker.
  const [binding] = await tx
    .select({ startedBy: projectBindings.startedBy })
    .from(projectBindings)
    .where(and(eq(projectBindings.id, bindingId), eq(projectBindings.projectId, project.id)));
  if (!binding) throw new Error('binding of another project');
  const now = new Date();
  for (let n = 1; n <= 50; n++) {
    const id = uuidv7();
    const rows = await tx
      .insert(requirementSources)
      .values({
        id,
        projectId: project.id,
        kind: 'external',
        name: n === 1 ? 'External tracker' : `External tracker ${n}`,
        bindingId,
        createdBy: binding.startedBy,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: requirementSources.id });
    if (rows.length) return rows[0]!.id;
  }
  throw new Error('no free name for the external source');
}

async function audit(
  tx: Tx,
  project: Project,
  action: string,
  targetType: string,
  targetId: string,
  summary: object,
) {
  await appendAudit(tx, {
    orgId: project.orgId,
    projectId: project.id,
    actorType: 'system',
    actorId: ACTOR_ID,
    action,
    targetType,
    targetId,
    summary: summary as Record<string, unknown>,
    source: 'worker',
  });
}

export type ExternalItemOutcome =
  | 'created'
  | 'new_version'
  | 'provenance_only'
  | 'marked_removed'
  | 'removed_before_import'
  | 'deferred_in_review'
  | 'deferred_obsolete'
  | 'duplicate'
  | 'stale'
  | 'ignored';

/** Outbox subscriber for `integration.requirement_item.changed`. */
export async function onRequirementItemChanged(
  event: DomainEvent<Record<string, unknown>>,
  tx: Tx,
): Promise<ExternalItemOutcome> {
  const p = event.payload;
  if (typeof p.externalRefId !== 'string' || typeof p.bindingId !== 'string' || !event.projectId)
    return 'ignored';
  const ref = await getExternalRef(tx, p.externalRefId);
  if (!ref || ref.projectId !== event.projectId || ref.externalType !== 'work_item') return 'ignored';
  // A newer revision was stored meanwhile; its own event applies it.
  if ((ref.externalVersion ?? null) !== (p.externalVersion ?? null)) return 'stale';
  const [row] = await tx
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, event.projectId));
  const project = row ? await findProjectById(tx, row.orgId, event.projectId) : null;
  if (!project || project.status !== 'active') return 'ignored';

  const snap = ref.snapshot as ItemSnapshot;
  const externalId = ref.externalId;
  const revision = ref.externalVersion ?? snap.revision ?? '0';
  const sourceId = await externalSource(tx, project, p.bindingId);
  const snapshotId = uuidv7();
  const now = new Date();
  const inserted = await tx
    .insert(sourceSnapshots)
    .values({
      id: snapshotId,
      projectId: project.id,
      sourceId,
      externalRefId: ref.id,
      externalVersion: revision,
      checksum: createHash('sha256').update(`work_item:${externalId}@${revision}`).digest('hex'),
      capturedAt: now,
      parseStatus: 'not_needed',
      extractionQuality: { externalId, revision, state: snap.state ?? null },
    })
    .onConflictDoNothing()
    .returning({ id: sourceSnapshots.id });
  if (!inserted.length) return 'duplicate';

  const content = clean(contentFromItem(externalId, snap));
  const locator = { workItem: externalId, revision, url: ref.externalUrl, field: 'System.Title' };
  const itemId = uuidv7();
  await tx.insert(extractedItems).values({
    id: itemId,
    projectId: project.id,
    snapshotId,
    kind: 'requirement',
    text: `${(snap.title ?? '').trim()}\n\n${snap.descriptionMarkdown ?? ''}`.trim().slice(0, 20_000),
    locator,
    language: null,
    confidence: '1.000',
    method: 'structural',
    externalKey: externalId,
    rule: 'external.item',
    status: 'accepted',
    createdAt: now,
  });
  const acIds: string[] = [];
  for (const a of content.acceptanceCriteria) {
    const id = uuidv7();
    acIds.push(id);
    await tx.insert(extractedItems).values({
      id,
      projectId: project.id,
      snapshotId,
      kind: 'ac',
      text: a.text,
      locator: { ...locator, field: 'Microsoft.VSTS.Common.AcceptanceCriteria' },
      language: null,
      confidence: '1.000',
      method: 'structural',
      parentItemId: itemId,
      rule: 'external.item',
      status: 'accepted',
      createdAt: now,
    });
  }

  // Earlier revisions of the same item in this source tell which requirement it is.
  const earlier = await tx
    .select({ id: extractedItems.id })
    .from(extractedItems)
    .innerJoin(sourceSnapshots, eq(sourceSnapshots.id, extractedItems.snapshotId))
    .where(
      and(
        eq(sourceSnapshots.sourceId, sourceId),
        eq(extractedItems.externalKey, externalId),
        eq(extractedItems.kind, 'requirement'),
      ),
    );
  const owners = await requirementsOfItems(
    tx,
    project,
    earlier.map((e) => e.id).filter((id) => id !== itemId),
  );
  const owner = [...owners.values()][0];
  const summary = { externalId, revision, snapshotId };

  if (!owner) {
    if (snap.removed) return 'removed_before_import';
    const n = await nextSequenceValue(tx, project.id, 'requirement');
    const key = `${project.key}-R-${n}`;
    const requirementId = uuidv7();
    await tx
      .insert(requirements)
      .values({ id: requirementId, projectId: project.id, key, createdAt: now, updatedAt: now });
    await insertVersion(tx, null, project, requirementId, 1, content, originOf('source', content), [
      itemId,
      ...acIds,
    ]);
    await audit(tx, project, 'requirement.created', 'requirement', requirementId, {
      ...summary,
      key,
      origin: 'source',
    });
    await appendOutbox(tx, {
      type: 'requirement.created',
      aggregateType: 'requirement',
      aggregateId: requirementId,
      projectId: project.id,
      payload: { key, source: 'external' },
    });
    return 'created';
  }

  if (snap.removed) {
    const rows = await tx
      .update(requirements)
      .set({ sourceRemoved: true, updatedAt: now })
      .where(and(eq(requirements.id, owner.id), eq(requirements.sourceRemoved, false)))
      .returning({ id: requirements.id });
    if (rows.length) {
      await flagForReview(
        tx,
        project,
        { type: 'requirement', ids: [owner.id] },
        { kind: 'source_removed', externalId, revision },
      );
      await audit(tx, project, 'requirement.source_removed', 'requirement', owner.id, {
        ...summary,
        key: owner.key,
      });
    }
    return 'marked_removed';
  }

  const earlierIds = earlier.map((e) => e.id).filter((id) => id !== itemId);
  const earlierCriteria = earlierIds.length
    ? await tx
        .select({ id: extractedItems.id })
        .from(extractedItems)
        .where(inArray(extractedItems.parentItemId, earlierIds))
    : [];
  const previous = new Set([...earlierIds, ...earlierCriteria.map((c) => c.id)]);
  const norm = (s: string) => normalizeForSearch(s);
  const r = await sourceDrivenVersion(
    tx,
    null,
    project,
    owner.id,
    (latest) => {
      const fromSource = new Set(content.acceptanceCriteria.map((a) => norm(a.text)));
      return {
        ...content,
        priority: latest.priority,
        // Criteria a person added stay; source criteria come from the tracker.
        acceptanceCriteria: [
          ...content.acceptanceCriteria,
          ...latest.acceptanceCriteria.filter(
            (a) => a.origin === 'inferred' && !fromSource.has(norm(a.text)),
          ),
        ].slice(0, 100),
      };
    },
    // Provenance: the item's earlier revisions (and their criteria) give way to this one.
    (items) => [...items.filter((i) => !previous.has(i)), itemId, ...acIds],
  );
  if (r.outcome === 'skipped') {
    await audit(tx, project, 'requirement.source_change.deferred', 'requirement', owner.id, {
      ...summary,
      key: owner.key,
      reason: r.reason,
    });
    return r.reason === 'in_review' ? 'deferred_in_review' : 'deferred_obsolete';
  }
  // The latest version now matches the source again.
  await tx
    .update(requirements)
    .set({ sourceRemoved: false, divergedFromSource: false, updatedAt: now })
    .where(eq(requirements.id, owner.id));
  if (r.outcome === 'created') {
    await flagForReview(
      tx,
      project,
      { type: 'requirement', ids: [owner.id] },
      {
        kind: 'source_changed',
        externalId,
        revision,
        version: r.version,
      },
    );
    await audit(tx, project, 'requirement.synced', 'requirement', owner.id, {
      ...summary,
      key: owner.key,
      version: r.version,
    });
    await appendOutbox(tx, {
      type: 'requirement.version.created',
      aggregateType: 'requirement',
      aggregateId: owner.id,
      projectId: project.id,
      payload: { version: r.version, cause: 'source_change', externalId },
    });
    return 'new_version';
  }
  return 'provenance_only';
}
