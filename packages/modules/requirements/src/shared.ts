import {
  acceptanceCriteria,
  and,
  appendAudit,
  asc,
  eq,
  inArray,
  requirementProvenance,
  requirements,
  requirementVersions,
  type Db,
  type Tx,
} from '@qos/db';
import type { Principal } from '@qos/identity';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import type { Project } from '@qos/projects';
import { cleanContent, contentHash, originOf, searchTextOf, type RequirementContent } from './domain.js';

// Helpers shared by the requirement and document workflows. Not part of the module's public surface.

/** Inserts a version with its criteria and provenance; updates the requirement's latest pointer. */
export async function insertVersion(
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

export function clean(input: RequirementContent): RequirementContent {
  try {
    return cleanContent(input);
  } catch (e) {
    throw new DomainError((e as Error).message);
  }
}

export async function audit(
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

/** The requirement each extracted item is a provenance of (any version), with its key and latest state. */
export async function requirementsOfItems(
  db: Db | Tx,
  project: Project,
  itemIds: readonly string[],
): Promise<Map<string, { id: string; key: string; state: string }>> {
  if (!itemIds.length) return new Map();
  const rows = await db
    .selectDistinct({
      itemId: requirementProvenance.extractedItemId,
      id: requirements.id,
      key: requirements.key,
      latestVersionId: requirements.latestVersionId,
    })
    .from(requirementProvenance)
    .innerJoin(requirementVersions, eq(requirementVersions.id, requirementProvenance.requirementVersionId))
    .innerJoin(requirements, eq(requirements.id, requirementVersions.requirementId))
    .where(
      and(
        inArray(requirementProvenance.extractedItemId, [...itemIds]),
        eq(requirements.projectId, project.id),
      ),
    );
  const latest = rows.length
    ? await db
        .select({ id: requirementVersions.id, state: requirementVersions.state })
        .from(requirementVersions)
        .where(
          inArray(
            requirementVersions.id,
            rows.map((r) => r.latestVersionId!),
          ),
        )
    : [];
  const out = new Map<string, { id: string; key: string; state: string }>();
  for (const r of rows) {
    out.set(r.itemId, {
      id: r.id,
      key: r.key,
      state: latest.find((l) => l.id === r.latestVersionId)?.state ?? 'draft',
    });
  }
  return out;
}

/** Content and provenance of a requirement's latest version, locked for a change. */
export async function lockedLatest(tx: Tx, project: Project, requirementId: string) {
  const [req] = await tx
    .select()
    .from(requirements)
    .where(and(eq(requirements.id, requirementId), eq(requirements.projectId, project.id)))
    .for('update');
  if (!req || !req.latestVersionId) throw new DomainError('requirement.not_found');
  const [latest] = await tx
    .select()
    .from(requirementVersions)
    .where(eq(requirementVersions.id, req.latestVersionId));
  const acs = await tx
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.requirementVersionId, latest!.id))
    .orderBy(asc(acceptanceCriteria.ordinal));
  const provenance = await tx
    .select({ id: requirementProvenance.extractedItemId })
    .from(requirementProvenance)
    .where(eq(requirementProvenance.requirementVersionId, latest!.id));
  const content: RequirementContent = {
    title: latest!.title,
    bodyMd: latest!.bodyMd,
    priority: latest!.priority as RequirementContent['priority'],
    tags: latest!.tags,
    acceptanceCriteria: acs.map((a) => ({ text: a.text, origin: a.origin as 'source' | 'inferred' })),
  };
  return { req, latest: latest!, content, provenance: provenance.map((p) => p.id) };
}

export type SourceVersionOutcome =
  | { readonly outcome: 'created'; readonly version: number }
  | { readonly outcome: 'provenance_only'; readonly version: number }
  | { readonly outcome: 'skipped'; readonly reason: 'in_review' | 'obsolete' };

/**
 * A change coming from a source (document version, merge, later: work item revision) as a new
 * draft version (BR-M04-4, BR-M04-9). The approved version stays effective; an unapproved draft
 * is superseded. A version in review or an obsolete requirement is left alone and reported.
 * Same content: only the provenance is added to the latest version.
 */
export async function sourceDrivenVersion(
  tx: Tx,
  actor: Principal,
  project: Project,
  requirementId: string,
  build: (latest: RequirementContent) => RequirementContent,
  provenance: (latest: readonly string[]) => readonly string[],
): Promise<SourceVersionOutcome> {
  const {
    latest,
    content: current,
    provenance: currentItems,
  } = await lockedLatest(tx, project, requirementId);
  if (latest.state === 'in_review') return { outcome: 'skipped', reason: 'in_review' };
  if (latest.state === 'obsolete') return { outcome: 'skipped', reason: 'obsolete' };
  const content = clean(build(current));
  const items = provenance(currentItems);
  if (contentHash(content) === latest.contentHash) {
    for (const itemId of new Set(items)) {
      await tx
        .insert(requirementProvenance)
        .values({ requirementVersionId: latest.id, extractedItemId: itemId })
        .onConflictDoNothing();
    }
    return { outcome: 'provenance_only', version: latest.number };
  }
  if (latest.state === 'draft' || latest.state === 'rejected') {
    await tx
      .update(requirementVersions)
      .set({ state: 'superseded' })
      .where(eq(requirementVersions.id, latest.id));
  }
  const origin =
    latest.origin === 'manual' || latest.origin === 'mixed' ? 'mixed' : originOf('source', content);
  await insertVersion(tx, actor, project, requirementId, latest.number + 1, content, origin, items);
  return { outcome: 'created', version: latest.number + 1 };
}

/** Title: the first sentence, up to 200 characters; the whole text stays in the body. */
export function contentFrom(
  text: string,
  externalKey: string | null,
  acs: readonly string[],
): RequirementContent {
  const first = /^(.{8,200}?[.!?؟])(\s|$)/s.exec(text)?.[1] ?? text;
  const title = first.length > 200 ? `${first.slice(0, 197).trimEnd()}…` : first;
  return {
    title: externalKey ? `${externalKey}: ${title}`.slice(0, 300) : title,
    bodyMd: text,
    priority: null,
    tags: [],
    acceptanceCriteria: acs.map((a) => ({ text: a, origin: 'source' as const })),
  };
}
