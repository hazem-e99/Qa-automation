import { and, connections, eq, externalRefs, sql, type Db, type Tx } from '@qos/db';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import type { ExternalRefData } from '@qos/ports';

export type ExternalRefStatus = 'live' | 'deleted_externally' | 'source_retired';

export interface ExternalRef {
  readonly id: string;
  readonly projectId: string | null;
  readonly connectionId: string;
  readonly providerType: string;
  readonly externalType: string;
  readonly externalId: string;
  readonly externalUrl: string | null;
  readonly externalVersion: string | null;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly status: ExternalRefStatus;
  readonly fetchedAt: string;
}

/** Snapshots are kept small and safe: a few top-level fields, bounded size (doc 11 §6). */
const MAX_SNAPSHOT_BYTES = 16 * 1024;

type Row = typeof externalRefs.$inferSelect;
const view = (r: Row): ExternalRef => ({
  id: r.id,
  projectId: r.projectId,
  connectionId: r.connectionId,
  providerType: r.providerType,
  externalType: r.externalType,
  externalId: r.externalId,
  externalUrl: r.externalUrl,
  externalVersion: r.externalVersion,
  snapshot: r.snapshot as Record<string, unknown>,
  status: r.status as ExternalRefStatus,
  fetchedAt: r.fetchedAt.toISOString(),
});

/**
 * Records (or refreshes) the handle to an external object. Unique per (connection, type, id), so
 * a repeated sync updates one row. Domain entities store the returned id, never raw provider ids.
 */
export async function upsertExternalRef(
  db: Db | Tx,
  connectionId: string,
  data: ExternalRefData,
  projectId: string | null = null,
): Promise<ExternalRef> {
  if (JSON.stringify(data.snapshot).length > MAX_SNAPSHOT_BYTES)
    throw new DomainError('external_ref.snapshot_too_large');
  const [conn] = await db
    .select({
      providerType: connections.providerType,
      status: connections.status,
      instance: connections.externalInstance,
    })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!conn) throw new DomainError('connection.not_found');
  if (conn.status === 'retired') throw new DomainError('connection.retired');
  const now = new Date();
  const [row] = await db
    .insert(externalRefs)
    .values({
      id: uuidv7(),
      projectId,
      connectionId,
      providerType: conn.providerType,
      externalInstance: conn.instance,
      externalType: data.externalType,
      externalId: data.externalId,
      externalUrl: data.externalUrl ?? null,
      externalVersion: data.externalVersion ?? null,
      snapshot: data.snapshot,
      status: 'live',
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: [externalRefs.connectionId, externalRefs.externalType, externalRefs.externalId],
      set: {
        externalUrl: data.externalUrl ?? null,
        externalVersion: data.externalVersion ?? null,
        snapshot: data.snapshot,
        status: 'live',
        fetchedAt: now,
        projectId: sql`coalesce(${externalRefs.projectId}, excluded.project_id)`,
      },
    })
    .returning();
  return view(row!);
}

export async function markDeletedExternally(db: Db | Tx, id: string): Promise<void> {
  await db
    .update(externalRefs)
    .set({ status: 'deleted_externally' })
    .where(and(eq(externalRefs.id, id), eq(externalRefs.status, 'live')));
}

export async function getExternalRef(db: Db | Tx, id: string): Promise<ExternalRef | null> {
  const [row] = await db.select().from(externalRefs).where(eq(externalRefs.id, id));
  return row ? view(row) : null;
}
