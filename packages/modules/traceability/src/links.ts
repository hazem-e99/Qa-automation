import { and, asc, eq, inArray, ne, or, sql, traceabilityLinks, type Db, type Tx } from '@qos/db';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import {
  linkShapeError,
  type EndpointType,
  type LinkOrigin,
  type LinkStatus,
  type LinkType,
} from './domain.js';

/**
 * The shared edge store. Owning modules validate that their endpoints exist in the project and
 * audit user actions; this module keeps edges consistent (shape, uniqueness, soft removal).
 * Every function takes the project, and every query filters on it (ProjectScope).
 */
export interface ProjectRef {
  readonly id: string;
}
export interface Endpoint {
  readonly type: EndpointType;
  readonly id: string;
  readonly versionId?: string | null;
}
export interface LinkView {
  readonly id: string;
  readonly type: LinkType;
  readonly from: { type: EndpointType; id: string; versionId: string | null };
  readonly to: { type: EndpointType; id: string; versionId: string | null };
  readonly acId: string | null;
  readonly status: LinkStatus;
  readonly needsReview: boolean;
  readonly reviewReason: Record<string, unknown> | null;
  readonly origin: LinkOrigin;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type Row = typeof traceabilityLinks.$inferSelect;
const view = (r: Row): LinkView => ({
  id: r.id,
  type: r.type as LinkType,
  from: { type: r.fromType as EndpointType, id: r.fromId, versionId: r.fromVersionId },
  to: { type: r.toType as EndpointType, id: r.toId, versionId: r.toVersionId },
  acId: r.acId,
  status: r.status as LinkStatus,
  needsReview: r.needsReview,
  reviewReason: (r.reviewReason as Record<string, unknown> | null) ?? null,
  origin: r.origin as LinkOrigin,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * Creates a link, or returns the live one with the same type and endpoints (idempotent). A live
 * link pointing at an older version is moved to the given versions.
 */
export async function createLink(
  db: Db | Tx,
  project: ProjectRef,
  input: {
    type: LinkType;
    from: Endpoint;
    to: Endpoint;
    acId?: string | null;
    origin: LinkOrigin;
    createdBy: string | null;
  },
): Promise<{ link: LinkView; created: boolean }> {
  const error = linkShapeError(input.type, input.from, input.to);
  if (error) throw new DomainError(error);
  const now = new Date();
  const [inserted] = await db
    .insert(traceabilityLinks)
    .values({
      id: uuidv7(),
      projectId: project.id,
      type: input.type,
      fromType: input.from.type,
      fromId: input.from.id,
      fromVersionId: input.from.versionId ?? null,
      toType: input.to.type,
      toId: input.to.id,
      toVersionId: input.to.versionId ?? null,
      acId: input.acId ?? null,
      origin: input.origin,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { link: view(inserted), created: true };
  const [existing] = await db
    .select()
    .from(traceabilityLinks)
    .where(
      and(
        eq(traceabilityLinks.projectId, project.id),
        eq(traceabilityLinks.type, input.type),
        eq(traceabilityLinks.fromType, input.from.type),
        eq(traceabilityLinks.fromId, input.from.id),
        eq(traceabilityLinks.toType, input.to.type),
        eq(traceabilityLinks.toId, input.to.id),
        ne(traceabilityLinks.status, 'removed'),
      ),
    );
  if (!existing) throw new DomainError('trace.link_conflict');
  const moved =
    (input.from.versionId !== undefined && input.from.versionId !== existing.fromVersionId) ||
    (input.to.versionId !== undefined && input.to.versionId !== existing.toVersionId);
  if (!moved) return { link: view(existing), created: false };
  const [updated] = await db
    .update(traceabilityLinks)
    .set({
      fromVersionId: input.from.versionId ?? existing.fromVersionId,
      toVersionId: input.to.versionId ?? existing.toVersionId,
      status: 'active',
      updatedAt: now,
    })
    .where(eq(traceabilityLinks.id, existing.id))
    .returning();
  return { link: view(updated!), created: false };
}

export async function getLink(db: Db | Tx, project: ProjectRef, linkId: string): Promise<LinkView | null> {
  const [row] = await db
    .select()
    .from(traceabilityLinks)
    .where(and(eq(traceabilityLinks.id, linkId), eq(traceabilityLinks.projectId, project.id)));
  return row ? view(row) : null;
}

/** Soft removal (history stays). Returns false when the link is not live in this project. */
export async function removeLink(db: Db | Tx, project: ProjectRef, linkId: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(traceabilityLinks)
    .set({ status: 'removed', removedAt: now, updatedAt: now })
    .where(
      and(
        eq(traceabilityLinks.id, linkId),
        eq(traceabilityLinks.projectId, project.id),
        ne(traceabilityLinks.status, 'removed'),
      ),
    )
    .returning({ id: traceabilityLinks.id });
  return rows.length > 0;
}

/** Live links touching any of the endpoints, in either direction unless `direction` says otherwise. */
export async function linksOf(
  db: Db | Tx,
  project: ProjectRef,
  endpointType: EndpointType,
  ids: readonly string[],
  opts: { direction?: 'from' | 'to' | 'both'; types?: readonly LinkType[]; includeRemoved?: boolean } = {},
): Promise<LinkView[]> {
  if (!ids.length) return [];
  const direction = opts.direction ?? 'both';
  const asTarget = and(eq(traceabilityLinks.toType, endpointType), inArray(traceabilityLinks.toId, [...ids]));
  const asSource = and(
    eq(traceabilityLinks.fromType, endpointType),
    inArray(traceabilityLinks.fromId, [...ids]),
  );
  const conds = [
    eq(traceabilityLinks.projectId, project.id),
    direction === 'to' ? asTarget : direction === 'from' ? asSource : or(asTarget, asSource),
  ];
  if (opts.types?.length) conds.push(inArray(traceabilityLinks.type, [...opts.types]));
  if (!opts.includeRemoved) conds.push(ne(traceabilityLinks.status, 'removed'));
  const rows = await db
    .select()
    .from(traceabilityLinks)
    .where(and(...conds))
    .orderBy(asc(traceabilityLinks.createdAt), asc(traceabilityLinks.id));
  return rows.map(view);
}

/**
 * Flags live links into the targets for review (M04-FR-16): their target changed or disappeared
 * at the source. Idempotent: a link already flagged keeps its first reason. Returns the links
 * flagged by this call.
 */
export async function flagForReview(
  db: Db | Tx,
  project: ProjectRef,
  target: { type: EndpointType; ids: readonly string[] },
  reason: Record<string, unknown>,
  types: readonly LinkType[] = ['verifies'],
): Promise<LinkView[]> {
  if (!target.ids.length) return [];
  const rows = await db
    .update(traceabilityLinks)
    .set({ needsReview: true, reviewReason: reason, updatedAt: new Date() })
    .where(
      and(
        eq(traceabilityLinks.projectId, project.id),
        eq(traceabilityLinks.toType, target.type),
        inArray(traceabilityLinks.toId, [...target.ids]),
        inArray(traceabilityLinks.type, [...types]),
        eq(traceabilityLinks.status, 'active'),
        eq(traceabilityLinks.needsReview, false),
      ),
    )
    .returning();
  return rows.map(view);
}

/** Clears the review flag after a human looked at the link. False when nothing was flagged. */
export async function markReviewed(db: Db | Tx, project: ProjectRef, linkId: string): Promise<boolean> {
  const rows = await db
    .update(traceabilityLinks)
    .set({ needsReview: false, reviewReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(traceabilityLinks.id, linkId),
        eq(traceabilityLinks.projectId, project.id),
        eq(traceabilityLinks.needsReview, true),
        ne(traceabilityLinks.status, 'removed'),
      ),
    )
    .returning({ id: traceabilityLinks.id });
  return rows.length > 0;
}

/** All live edges of one type in the project (endpoint ids only), e.g. the requirement hierarchy. */
export async function edgesOfType(
  db: Db | Tx,
  project: ProjectRef,
  type: LinkType,
): Promise<{ fromId: string; toId: string }[]> {
  return db
    .select({ fromId: traceabilityLinks.fromId, toId: traceabilityLinks.toId })
    .from(traceabilityLinks)
    .where(
      and(
        eq(traceabilityLinks.projectId, project.id),
        eq(traceabilityLinks.type, type),
        ne(traceabilityLinks.status, 'removed'),
      ),
    );
}

/** Counts of live links per target id and type, for list screens and exports. */
export async function linkCounts(
  db: Db | Tx,
  project: ProjectRef,
  targetType: EndpointType,
  type: LinkType,
): Promise<Map<string, { total: number; needsReview: number }>> {
  const rows = await db
    .select({
      toId: traceabilityLinks.toId,
      total: sql<number>`count(*)::int`,
      needsReview: sql<number>`count(*) filter (where ${traceabilityLinks.needsReview})::int`,
    })
    .from(traceabilityLinks)
    .where(
      and(
        eq(traceabilityLinks.projectId, project.id),
        eq(traceabilityLinks.toType, targetType),
        eq(traceabilityLinks.type, type),
        eq(traceabilityLinks.status, 'active'),
      ),
    )
    .groupBy(traceabilityLinks.toId);
  return new Map(rows.map((r) => [r.toId, { total: r.total, needsReview: r.needsReview }]));
}
