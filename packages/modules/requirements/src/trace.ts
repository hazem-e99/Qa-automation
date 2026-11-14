import { and, eq, inArray, requirements, requirementVersions, type Db } from '@qos/db';
import type { Principal } from '@qos/identity';
import { DomainError } from '@qos/kernel-domain';
import { assertProjectWritable, type Project } from '@qos/projects';
import {
  coverageOf,
  createLink,
  edgesOfType,
  getLink,
  linksOf,
  markReviewed,
  removeLink,
  wouldCycle,
  type Coverage,
  type LinkView,
} from '@qos/traceability';
import { audit } from './shared.js';

/**
 * Requirement side of the traceability graph (T-P3-12, M04-FR-17): hierarchy and related links
 * between requirements, the tests that verify a requirement (written by test management from P4),
 * coverage, and the review flags set when a requirement changed at its source.
 */
export const REQUIREMENT_LINK_TYPES = ['child_of', 'relates_to'] as const;
export type RequirementLinkType = (typeof REQUIREMENT_LINK_TYPES)[number];

export interface RequirementRef {
  readonly linkId: string;
  readonly requirementId: string;
  readonly key: string;
  readonly title: string;
}
export interface VerifyingTest {
  readonly linkId: string;
  readonly testCaseId: string;
  readonly testCaseVersionId: string | null;
  /** The requirement version the test was linked to (null when not pinned to one). */
  readonly requirementVersion: number | null;
  readonly needsReview: boolean;
  readonly reviewReason: Record<string, unknown> | null;
}
export interface RequirementTrace {
  readonly requirementId: string;
  readonly key: string;
  readonly coverage: Coverage;
  readonly parents: RequirementRef[];
  readonly children: RequirementRef[];
  readonly related: RequirementRef[];
  readonly verifiedBy: VerifyingTest[];
  readonly defects: { linkId: string; defectId: string }[];
  readonly needsReview: number;
}

async function titles(db: Db, project: Project, ids: readonly string[]) {
  if (!ids.length) return new Map<string, { key: string; title: string }>();
  const rows = await db
    .select({ id: requirements.id, key: requirements.key, title: requirementVersions.title })
    .from(requirements)
    .innerJoin(requirementVersions, eq(requirementVersions.id, requirements.latestVersionId))
    .where(and(eq(requirements.projectId, project.id), inArray(requirements.id, [...ids])));
  return new Map(rows.map((r) => [r.id, { key: r.key, title: r.title }]));
}

async function keyOf(db: Db, project: Project, requirementId: string): Promise<string> {
  const [row] = await db
    .select({ key: requirements.key })
    .from(requirements)
    .where(and(eq(requirements.id, requirementId), eq(requirements.projectId, project.id)));
  if (!row) throw new DomainError('requirement.not_found');
  return row.key;
}

export async function requirementTrace(
  db: Db,
  project: Project,
  requirementId: string,
): Promise<RequirementTrace> {
  const key = await keyOf(db, project, requirementId);
  const links = await linksOf(db, project, 'requirement', [requirementId]);
  const other = (l: LinkView) =>
    l.from.type === 'requirement' && l.from.id === requirementId ? l.to : l.from;
  const reqLinks = links.filter((l) => l.from.type === 'requirement' && l.to.type === 'requirement');
  const names = await titles(
    db,
    project,
    reqLinks.map((l) => other(l).id),
  );
  const ref = (l: LinkView): RequirementRef[] => {
    const o = names.get(other(l).id);
    return o ? [{ linkId: l.id, requirementId: other(l).id, key: o.key, title: o.title }] : [];
  };
  const verifies = links.filter((l) => l.type === 'verifies' && l.to.id === requirementId);
  const versionIds = [...new Set(verifies.flatMap((l) => (l.to.versionId ? [l.to.versionId] : [])))];
  const numbers = versionIds.length
    ? await db
        .select({ id: requirementVersions.id, number: requirementVersions.number })
        .from(requirementVersions)
        .where(
          and(
            eq(requirementVersions.requirementId, requirementId),
            inArray(requirementVersions.id, versionIds),
          ),
        )
    : [];
  return {
    requirementId,
    key,
    coverage: coverageOf(verifies),
    parents: reqLinks.filter((l) => l.type === 'child_of' && l.from.id === requirementId).flatMap(ref),
    children: reqLinks.filter((l) => l.type === 'child_of' && l.to.id === requirementId).flatMap(ref),
    related: reqLinks.filter((l) => l.type === 'relates_to').flatMap(ref),
    verifiedBy: verifies.map((l) => ({
      linkId: l.id,
      testCaseId: l.from.id,
      testCaseVersionId: l.from.versionId,
      requirementVersion: numbers.find((n) => n.id === l.to.versionId)?.number ?? null,
      needsReview: l.needsReview,
      reviewReason: l.reviewReason,
    })),
    defects: links
      .filter((l) => l.type === 'affects' && l.to.id === requirementId)
      .map((l) => ({ linkId: l.id, defectId: l.from.id })),
    needsReview: links.filter((l) => l.needsReview).length,
  };
}

/**
 * Links two requirements. `child_of`: this requirement becomes a child of `targetKey` (one parent,
 * no cycles). `relates_to`: a symmetric relation, stored once whichever side creates it.
 */
export async function linkRequirement(
  db: Db,
  actor: Principal,
  project: Project,
  requirementId: string,
  input: { type: RequirementLinkType; targetKey: string },
): Promise<RequirementTrace> {
  assertProjectWritable(project);
  if (!(REQUIREMENT_LINK_TYPES as readonly string[]).includes(input.type))
    throw new DomainError('trace.link_type_invalid');
  await db.transaction(async (tx) => {
    const [self] = await tx
      .select({ id: requirements.id, key: requirements.key })
      .from(requirements)
      .where(and(eq(requirements.id, requirementId), eq(requirements.projectId, project.id)))
      .for('update');
    if (!self) throw new DomainError('requirement.not_found');
    const [target] = await tx
      .select({ id: requirements.id, key: requirements.key })
      .from(requirements)
      .where(and(eq(requirements.key, input.targetKey), eq(requirements.projectId, project.id)));
    if (!target) throw new DomainError('trace.target_not_found');
    if (target.id === self.id) throw new DomainError('trace.self_link');
    let from = self.id;
    let to = target.id;
    if (input.type === 'child_of') {
      const parentsOf = new Map<string, string[]>();
      for (const e of await edgesOfType(tx, project, 'child_of'))
        parentsOf.set(e.fromId, [...(parentsOf.get(e.fromId) ?? []), e.toId]);
      const current = parentsOf.get(self.id) ?? [];
      if (current.includes(target.id)) return;
      if (current.length) throw new DomainError('trace.parent_exists');
      if (wouldCycle(self.id, target.id, parentsOf)) throw new DomainError('trace.cycle');
    } else if (to < from) {
      [from, to] = [to, from];
    }
    const { link, created } = await createLink(tx, project, {
      type: input.type,
      from: { type: 'requirement', id: from },
      to: { type: 'requirement', id: to },
      origin: 'user',
      createdBy: actor.userId,
    });
    if (created) {
      await audit(tx, actor, project, 'trace.link.created', 'traceability_link', link.id, {
        type: input.type,
        from: from === self.id ? self.key : target.key,
        to: to === target.id ? target.key : self.key,
      });
    }
  });
  return requirementTrace(db, project, requirementId);
}

/** Removes a hierarchy or related link of this requirement. Test links are managed by their tests. */
export async function unlinkRequirement(
  db: Db,
  actor: Principal,
  project: Project,
  requirementId: string,
  linkId: string,
): Promise<RequirementTrace> {
  assertProjectWritable(project);
  await db.transaction(async (tx) => {
    const link = await getLink(tx, project, linkId);
    const touches =
      link &&
      link.status !== 'removed' &&
      (REQUIREMENT_LINK_TYPES as readonly string[]).includes(link.type) &&
      (link.from.id === requirementId || link.to.id === requirementId);
    if (!touches) throw new DomainError('trace.link_not_found');
    await removeLink(tx, project, linkId);
    await audit(tx, actor, project, 'trace.link.removed', 'traceability_link', linkId, { type: link.type });
  });
  return requirementTrace(db, project, requirementId);
}

/** A human confirmed a flagged link still holds after the requirement changed (clears `needs_review`). */
export async function reviewTraceLink(
  db: Db,
  actor: Principal,
  project: Project,
  requirementId: string,
  linkId: string,
): Promise<RequirementTrace> {
  assertProjectWritable(project);
  await db.transaction(async (tx) => {
    const link = await getLink(tx, project, linkId);
    if (!link || link.to.type !== 'requirement' || link.to.id !== requirementId)
      throw new DomainError('trace.link_not_found');
    if (await markReviewed(tx, project, linkId)) {
      await audit(tx, actor, project, 'trace.link.reviewed', 'traceability_link', linkId, {
        type: link.type,
        reason: link.reviewReason,
      });
    }
  });
  return requirementTrace(db, project, requirementId);
}
