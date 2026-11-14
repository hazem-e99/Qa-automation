import {
  and,
  asc,
  eq,
  extractedItems,
  inArray,
  requirements,
  sourceSnapshots,
  sql,
  type Db,
  type Tx,
} from '@qos/db';
import type { Principal } from '@qos/identity';
import { appendOutbox } from '@qos/jobs';
import { DomainError } from '@qos/kernel-domain';
import { assertProjectWritable, type Project } from '@qos/projects';
import { flagForReview, linksOf } from '@qos/traceability';
import { diffSnapshots, normalizeForSearch, type DiffItem } from './domain.js';
import { audit, contentFrom, requirementsOfItems, sourceDrivenVersion } from './shared.js';

/**
 * Change detection and impact for document versions (M04-FR-15/16, T-P3-11, M04-AC-04). A parsed
 * snapshot is compared with the previous parsed version of the same document at requirement and
 * acceptance-criterion level; requirements that came from changed or removed items, and the tests
 * linked to them, form the impact list. Applying the changes never alters an approved version or a
 * test (BR-M04-4/5): it creates draft versions, marks removals and flags links for review.
 */
const LIVE = ['candidate', 'accepted', 'merged'];

export interface ChangeItem extends DiffItem {
  readonly itemId: string;
  readonly status: string;
  readonly locator: Record<string, unknown>;
  readonly acItemIds: readonly string[];
  readonly requirement: { id: string; key: string; state: string } | null;
}
export interface ImpactedTest {
  readonly linkId: string;
  readonly testCaseId: string;
  readonly testCaseVersionId: string | null;
  readonly requirementKey: string;
  readonly needsReview: boolean;
}
export interface SnapshotChanges {
  readonly snapshotId: string;
  readonly previousSnapshotId: string;
  readonly added: ChangeItem[];
  readonly removed: ChangeItem[];
  readonly changed: {
    before: ChangeItem;
    after: ChangeItem;
    fields: ('title' | 'body' | 'acceptanceCriteria')[];
    ac: { added: string[]; removed: string[] };
  }[];
  readonly unchanged: { before: ChangeItem; after: ChangeItem }[];
  readonly impact: {
    readonly requirements: { id: string; key: string; state: string; change: 'changed' | 'removed' }[];
    readonly testCases: ImpactedTest[];
  };
}

type SnapshotRow = typeof sourceSnapshots.$inferSelect;

async function snapshotOf(db: Db | Tx, project: Project, snapshotId: string): Promise<SnapshotRow> {
  const [row] = await db
    .select()
    .from(sourceSnapshots)
    .where(and(eq(sourceSnapshots.id, snapshotId), eq(sourceSnapshots.projectId, project.id)));
  if (!row) throw new DomainError('snapshot.not_found');
  if (row.parseStatus !== 'parsed') throw new DomainError('snapshot.not_parsed');
  return row;
}

/** The parsed version just before this one in its document series. */
async function previousOf(db: Db | Tx, project: Project, snap: SnapshotRow): Promise<SnapshotRow> {
  if (!snap.documentId) throw new DomainError('snapshot.no_previous');
  const [prev] = await db
    .select()
    .from(sourceSnapshots)
    .where(
      and(
        eq(sourceSnapshots.projectId, project.id),
        eq(sourceSnapshots.documentId, snap.documentId),
        eq(sourceSnapshots.parseStatus, 'parsed'),
        sql`(${sourceSnapshots.capturedAt}, ${sourceSnapshots.id}) < (${snap.capturedAt}, ${snap.id})`,
      ),
    )
    .orderBy(sql`${sourceSnapshots.capturedAt} desc, ${sourceSnapshots.id} desc`)
    .limit(1);
  if (!prev) throw new DomainError('snapshot.no_previous');
  return prev;
}

async function itemsOf(db: Db | Tx, project: Project, snapshotId: string): Promise<ChangeItem[]> {
  const rows = await db
    .select()
    .from(extractedItems)
    .where(
      and(
        eq(extractedItems.snapshotId, snapshotId),
        eq(extractedItems.projectId, project.id),
        inArray(extractedItems.status, LIVE),
      ),
    )
    .orderBy(asc(extractedItems.id));
  const reqs = rows.filter((r) => r.kind === 'requirement');
  const owners = await requirementsOfItems(
    db,
    project,
    reqs.map((r) => r.id),
  );
  return reqs.map((r) => {
    const acs = rows.filter((a) => a.kind === 'ac' && a.parentItemId === r.id);
    const title = contentFrom(r.text, null, []).title;
    return {
      itemId: r.id,
      externalKey: r.externalKey,
      title,
      body: r.text,
      acceptanceCriteria: acs.map((a) => a.text),
      acItemIds: acs.map((a) => a.id),
      status: r.status,
      locator: r.locator as Record<string, unknown>,
      requirement: owners.get(r.id) ?? null,
    };
  });
}

async function compare(
  db: Db | Tx,
  project: Project,
  snapshotId: string,
  againstId?: string,
): Promise<SnapshotChanges> {
  const snap = await snapshotOf(db, project, snapshotId);
  const prev = againstId ? await snapshotOf(db, project, againstId) : await previousOf(db, project, snap);
  if (prev.id === snap.id || prev.sourceId !== snap.sourceId)
    throw new DomainError('snapshot.not_comparable');
  const d = diffSnapshots(await itemsOf(db, project, prev.id), await itemsOf(db, project, snap.id));
  const impacted = new Map<
    string,
    { id: string; key: string; state: string; change: 'changed' | 'removed' }
  >();
  for (const c of d.changed)
    if (c.before.requirement)
      impacted.set(c.before.requirement.id, { ...c.before.requirement, change: 'changed' });
  for (const r of d.removed)
    if (r.requirement && !impacted.has(r.requirement.id))
      impacted.set(r.requirement.id, { ...r.requirement, change: 'removed' });
  const links = await linksOf(db, project, 'requirement', [...impacted.keys()], {
    direction: 'to',
    types: ['verifies'],
  });
  return {
    snapshotId: snap.id,
    previousSnapshotId: prev.id,
    added: d.added,
    removed: d.removed,
    changed: d.changed,
    unchanged: d.unchangedPairs,
    impact: {
      requirements: [...impacted.values()],
      testCases: links.map((l) => ({
        linkId: l.id,
        testCaseId: l.from.id,
        testCaseVersionId: l.from.versionId,
        requirementKey: impacted.get(l.to.id)!.key,
        needsReview: l.needsReview,
      })),
    },
  };
}

/** What changed between this snapshot and the previous version (or `againstId`), and what it affects. */
export function snapshotChanges(
  db: Db,
  project: Project,
  snapshotId: string,
  againstId?: string,
): Promise<SnapshotChanges> {
  return compare(db, project, snapshotId, againstId);
}

export interface ApplyChangesOutcome {
  /** Unchanged items now also count as provenance of their requirement (no new version). */
  readonly carried: number;
  readonly newVersions: { key: string; version: number }[];
  readonly markedRemoved: string[];
  readonly skipped: { key: string; reason: 'in_review' | 'obsolete' }[];
  readonly flaggedLinks: number;
  /** Added items stay candidates for the normal review. */
  readonly added: number;
}

const norm = (s: string) => normalizeForSearch(s);

/**
 * Applies a document version's changes to the requirements of the previous version
 * (BR-M04-4/5, M04-AC-04). Idempotent: only items still `candidate` are acted on, and a removal
 * already marked stays as it is.
 */
export async function applySnapshotChanges(
  db: Db,
  actor: Principal,
  project: Project,
  snapshotId: string,
): Promise<ApplyChangesOutcome> {
  assertProjectWritable(project);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`qos:apply-changes:${snapshotId}`}))`);
    const changes = await compare(tx, project, snapshotId);
    let carried = 0;
    let flaggedLinks = 0;
    const newVersions: ApplyChangesOutcome['newVersions'][number][] = [];
    const skipped: ApplyChangesOutcome['skipped'][number][] = [];
    const markedRemoved: string[] = [];
    const settle = async (after: ChangeItem, status: 'merged' | 'accepted') =>
      tx
        .update(extractedItems)
        .set({ status })
        .where(
          and(
            inArray(extractedItems.id, [after.itemId, ...after.acItemIds]),
            eq(extractedItems.status, 'candidate'),
          ),
        );

    for (const { before, after } of changes.unchanged) {
      if (!before.requirement || after.status !== 'candidate') continue;
      const r = await sourceDrivenVersion(
        tx,
        actor,
        project,
        before.requirement.id,
        (latest) => latest,
        (items) => [...items, after.itemId, ...after.acItemIds],
      );
      if (r.outcome === 'skipped') {
        skipped.push({ key: before.requirement.key, reason: r.reason });
        continue;
      }
      await settle(after, 'merged');
      carried++;
    }

    for (const c of changes.changed) {
      const owner = c.before.requirement;
      if (!owner || c.after.status !== 'candidate') continue;
      const dropped = new Set([c.before.itemId, ...c.before.acItemIds]);
      const r = await sourceDrivenVersion(
        tx,
        actor,
        project,
        owner.id,
        (latest) => {
          const fresh = contentFrom(c.after.body, c.after.externalKey ?? null, c.after.acceptanceCriteria);
          const sourceAcs = new Set(fresh.acceptanceCriteria.map((a) => norm(a.text)));
          return {
            ...fresh,
            priority: latest.priority,
            tags: latest.tags,
            // Criteria a human added (inferred) stay; source criteria come from the new version.
            acceptanceCriteria: [
              ...fresh.acceptanceCriteria,
              ...latest.acceptanceCriteria.filter(
                (a) => a.origin === 'inferred' && !sourceAcs.has(norm(a.text)),
              ),
            ],
          };
        },
        (items) => [...items.filter((i) => !dropped.has(i)), c.after.itemId, ...c.after.acItemIds],
      );
      if (r.outcome === 'skipped') {
        skipped.push({ key: owner.key, reason: r.reason });
        continue;
      }
      await settle(c.after, 'accepted');
      const flagged = await flagForReview(
        tx,
        project,
        { type: 'requirement', ids: [owner.id] },
        {
          kind: 'source_changed',
          snapshotId,
          version: r.version,
          fields: c.fields,
        },
      );
      flaggedLinks += flagged.length;
      if (r.outcome === 'created') {
        newVersions.push({ key: owner.key, version: r.version });
        await appendOutbox(tx, {
          type: 'requirement.version.created',
          aggregateType: 'requirement',
          aggregateId: owner.id,
          projectId: project.id,
          payload: { version: r.version, cause: 'source_change', snapshotId },
        });
      }
    }

    for (const item of changes.removed) {
      const owner = item.requirement;
      if (!owner) continue;
      const rows = await tx
        .update(requirements)
        .set({ sourceRemoved: true, updatedAt: new Date() })
        .where(
          and(
            eq(requirements.id, owner.id),
            eq(requirements.projectId, project.id),
            eq(requirements.sourceRemoved, false),
          ),
        )
        .returning({ id: requirements.id });
      if (!rows.length) continue;
      markedRemoved.push(owner.key);
      const flagged = await flagForReview(
        tx,
        project,
        { type: 'requirement', ids: [owner.id] },
        {
          kind: 'source_removed',
          snapshotId,
        },
      );
      flaggedLinks += flagged.length;
    }

    const outcome: ApplyChangesOutcome = {
      carried,
      newVersions,
      markedRemoved,
      skipped,
      flaggedLinks,
      added: changes.added.filter((a) => a.status === 'candidate').length,
    };
    if (carried || newVersions.length || markedRemoved.length) {
      await audit(tx, actor, project, 'requirement.document.changes_applied', 'source_snapshot', snapshotId, {
        previousSnapshotId: changes.previousSnapshotId,
        carried,
        newVersions: newVersions.slice(0, 50),
        markedRemoved: markedRemoved.slice(0, 50),
        skipped: skipped.slice(0, 50),
        flaggedLinks,
      });
    }
    return outcome;
  });
}
