import { and, auditEvents, desc, eq, sql, type Db, type SQL } from '@qos/db';
import { DomainError } from '@qos/kernel-domain';

/**
 * Audit log search (M14-FR-01, S-SEC-01). Always inside one organization; optionally one project.
 * Keyset pagination on (created_at, id), newest first, so pages stay stable while events arrive.
 */
export interface AuditQuery {
  readonly orgId: string;
  readonly projectId?: string | null;
  readonly action?: string | null;
  readonly actorId?: string | null;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly from?: Date | null;
  readonly to?: Date | null;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface AuditEventView {
  readonly id: string;
  readonly projectId: string | null;
  readonly actorType: string;
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly summary: Record<string, unknown>;
  readonly source: string;
  readonly correlationId: string | null;
  readonly hash: string;
  readonly createdAt: string;
}

const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(ts ?? '');
  if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id ?? '')) {
    throw new DomainError('audit.cursor_invalid');
  }
  return { createdAt, id: id! };
}

export async function searchAudit(
  db: Db,
  q: AuditQuery,
): Promise<{ items: AuditEventView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const where: SQL[] = [eq(auditEvents.orgId, q.orgId)];
  if (q.projectId) where.push(eq(auditEvents.projectId, q.projectId));
  if (q.action) {
    // A trailing `*` matches a prefix, e.g. `identity.*`.
    where.push(
      q.action.endsWith('*')
        ? sql`${auditEvents.action} like ${q.action.slice(0, -1).replace(/[%_\\]/g, '\\$&') + '%'}`
        : eq(auditEvents.action, q.action),
    );
  }
  if (q.actorId) where.push(eq(auditEvents.actorId, q.actorId));
  if (q.targetType) where.push(eq(auditEvents.targetType, q.targetType));
  if (q.targetId) where.push(eq(auditEvents.targetId, q.targetId));
  if (q.from) where.push(sql`${auditEvents.createdAt} >= ${q.from.toISOString()}`);
  if (q.to) where.push(sql`${auditEvents.createdAt} < ${q.to.toISOString()}`);
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    where.push(sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${c.createdAt.toISOString()}, ${c.id})`);
  }
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...where))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      actorType: r.actorType,
      actorId: r.actorId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      summary: r.summary as Record<string, unknown>,
      source: r.source,
      correlationId: r.correlationId,
      hash: r.hash,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
