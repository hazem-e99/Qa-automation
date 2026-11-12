import {
  and,
  connections,
  desc,
  eq,
  inArray,
  isNull,
  projectBindings,
  sql,
  syncCursors,
  syncErrors,
  syncRuns,
  type Db,
} from '@qos/db';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import {
  ProviderError,
  type CapabilityId,
  type ConnectionContext,
  type ExternalRefData,
  type Page,
  type ProviderAdapter,
  type RepositoryProvider,
} from '@qos/ports';
import { contextFor, type IntegrationDeps } from './connections.js';
import { upsertExternalRef } from './external-refs.js';

/**
 * A sync stream: one kind of external object pulled for one binding role (doc 13 §1, ADR-0014).
 * Streams are pure translation: fetch a page, map items to ExternalRefData. Persistence, cursors,
 * errors and the breaker are handled by the framework.
 */
export interface SyncStream {
  readonly name: string;
  readonly role: string;
  readonly requires: readonly CapabilityId[];
  fetchPage(
    adapter: ProviderAdapter,
    ctx: ConnectionContext,
    config: Readonly<Record<string, unknown>>,
    cursor: string | undefined,
  ): Promise<Page<ExternalRefData>>;
}

/** Commits of the bound repository's default branch. */
export const repositoryCommitsStream: SyncStream = {
  name: 'repository.commits',
  role: 'repository',
  requires: ['repo.read@1', 'repo.commits.list@1'],
  async fetchPage(adapter, ctx, config, cursor) {
    const repoId = typeof config.repoId === 'string' ? config.repoId : null;
    if (!repoId) throw new ProviderError('validation', 'binding has no repoId', { field: 'repoId' });
    const repo = adapter as RepositoryProvider;
    const branch =
      typeof config.branch === 'string' ? config.branch : (await repo.getRepo(ctx, repoId)).defaultBranch;
    const page = await repo.listCommits(ctx, repoId, branch, cursor);
    return {
      ...page,
      items: page.items.map((c) => ({
        externalType: 'commit',
        externalId: `${repoId}:${c.sha}`,
        externalVersion: c.sha,
        snapshot: {
          sha: c.sha,
          message: c.message.slice(0, 500),
          author: c.author,
          timestamp: c.timestamp,
          ...(c.changedPaths ? { changedPaths: c.changedPaths.slice(0, 100) } : {}),
        },
      })),
    };
  },
};

export const SYNC_STREAMS: readonly SyncStream[] = [repositoryCommitsStream];
export const streamsForRole = (role: string) => SYNC_STREAMS.filter((s) => s.role === role);
const streamByName = (name: string) => SYNC_STREAMS.find((s) => s.name === name);

export type SyncMode = 'incremental' | 'full';
export type SyncStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'deferred';

export interface SyncResult {
  readonly runId: string | null;
  readonly status: SyncStatus | 'skipped';
  readonly reason?: 'already_running' | 'breaker_open' | 'binding_inactive';
  readonly pages: number;
  readonly itemsSeen: number;
  readonly itemsChanged: number;
  readonly errorKind: string | null;
  readonly retryAfterMs: number | null;
}

export interface SyncOptions {
  readonly mode?: SyncMode;
  /** Rate budget per run (doc 13): stop after this many pages and continue in the next run. */
  readonly maxPages?: number;
  readonly now?: () => Date;
}

/** Doc 22 §6: opens after 5 consecutive unavailable/timeout failures within 60 s, probes after 60 s. */
export const BREAKER = { failures: 5, windowMs: 60_000, cooldownMs: 60_000 } as const;
const TRANSIENT = ['unavailable', 'timeout'];

export async function breakerState(db: Db, connectionId: string, now: Date = new Date()) {
  const recent = await db
    .select({ status: syncRuns.status, errorKind: syncRuns.errorKind, startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(and(eq(syncRuns.connectionId, connectionId), sql`${syncRuns.status} <> 'running'`))
    .orderBy(desc(syncRuns.startedAt))
    .limit(BREAKER.failures);
  const tripped =
    recent.length === BREAKER.failures &&
    recent.every((r) => r.status === 'failed' && TRANSIENT.includes(r.errorKind ?? '')) &&
    recent[0]!.startedAt.getTime() - recent.at(-1)!.startedAt.getTime() <= BREAKER.windowMs;
  if (!tripped) return { open: false as const };
  const until = new Date(recent[0]!.startedAt.getTime() + BREAKER.cooldownMs);
  return until > now ? { open: true as const, until } : { open: false as const, halfOpen: true as const };
}

/**
 * Runs one sync of one stream for one binding. Each page is stored together with the cursor
 * after it, so a crash or a provider failure resumes exactly where the last good page ended.
 */
export async function runSync(
  deps: IntegrationDeps,
  bindingId: string,
  streamName: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  const stream = streamByName(streamName);
  if (!stream) throw new DomainError('sync.stream_unknown');
  const [row] = await deps.db
    .select({ binding: projectBindings, connection: connections })
    .from(projectBindings)
    .innerJoin(connections, eq(connections.id, projectBindings.connectionId))
    .where(eq(projectBindings.id, bindingId));
  const empty = { pages: 0, itemsSeen: 0, itemsChanged: 0, errorKind: null, retryAfterMs: null };
  if (
    !row ||
    row.binding.endedAt ||
    row.connection.status === 'retired' ||
    row.binding.role !== stream.role
  ) {
    return { runId: null, status: 'skipped', reason: 'binding_inactive', ...empty };
  }
  if ((await breakerState(deps.db, row.connection.id, now())).open) {
    return { runId: null, status: 'skipped', reason: 'breaker_open', ...empty };
  }

  const runId = uuidv7();
  const mode: SyncMode = opts.mode ?? 'incremental';
  try {
    await deps.db.insert(syncRuns).values({
      id: runId,
      bindingId,
      connectionId: row.connection.id,
      stream: stream.name,
      mode,
      status: 'running',
      startedAt: now(),
    });
  } catch {
    // The partial unique index refused a second running sync for this binding and stream.
    return { runId: null, status: 'skipped', reason: 'already_running', ...empty };
  }

  const ctx = contextFor(deps, row.connection);
  let cursor: string | undefined;
  if (mode === 'incremental') {
    const [c] = await deps.db
      .select({ cursor: syncCursors.cursor })
      .from(syncCursors)
      .where(and(eq(syncCursors.bindingId, bindingId), eq(syncCursors.stream, stream.name)));
    cursor = c?.cursor ?? undefined;
  }
  let pages = 0;
  let itemsSeen = 0;
  let itemsChanged = 0;
  let status: SyncStatus = 'succeeded';
  let errorKind: string | null = null;
  let retryAfterMs: number | null = null;
  const maxPages = opts.maxPages ?? 50;

  try {
    const adapter = deps.registry.require(row.connection.providerType, stream.requires);
    for (;;) {
      const page = await stream.fetchPage(
        adapter,
        ctx,
        row.binding.config as Record<string, unknown>,
        cursor,
      );
      const nextSaved = page.nextCursor ?? page.resumeCursor ?? cursor ?? null;
      await deps.db.transaction(async (tx) => {
        for (const item of page.items) {
          const before = await upsertExternalRefChanged(tx, row.connection.id, item, row.binding.projectId);
          if (before) itemsChanged++;
        }
        await tx
          .insert(syncCursors)
          .values({ bindingId, stream: stream.name, cursor: nextSaved, updatedAt: now() })
          .onConflictDoUpdate({
            target: [syncCursors.bindingId, syncCursors.stream],
            set: { cursor: nextSaved, updatedAt: now() },
          });
      });
      pages++;
      itemsSeen += page.items.length;
      cursor = nextSaved ?? undefined;
      if (!page.nextCursor) break;
      if (pages >= maxPages) {
        status = 'partial'; // budget used up; the next run continues from the saved cursor
        break;
      }
    }
  } catch (e) {
    const kind = e instanceof ProviderError ? e.kind : e instanceof DomainError ? 'validation' : 'unknown';
    errorKind = kind;
    if (kind === 'rate_limited') {
      status = 'deferred';
      retryAfterMs = e instanceof ProviderError ? (e.details.retryAfterMs ?? 60_000) : 60_000;
    } else {
      status = 'failed';
    }
    await deps.db.insert(syncErrors).values({
      id: uuidv7(),
      syncRunId: runId,
      kind,
      message: `sync stopped after ${pages} page(s): ${kind}`,
      status: 'open',
      createdAt: now(),
    });
    deps.logger.warn({ bindingId, stream: stream.name, errorKind: kind, pages }, 'sync stopped');
  }

  await deps.db
    .update(syncRuns)
    .set({ status, finishedAt: now(), pages, itemsSeen, itemsChanged, errorKind, retryAfterMs })
    .where(eq(syncRuns.id, runId));
  return { runId, status, pages, itemsSeen, itemsChanged, errorKind, retryAfterMs };
}

/** Upserts and reports whether the stored version changed (new object or new version). */
async function upsertExternalRefChanged(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  connectionId: string,
  item: ExternalRefData,
  projectId: string,
): Promise<boolean> {
  const existing = await tx.execute<{ external_version: string | null }>(
    sql`select external_version from integrations.external_refs
        where connection_id = ${connectionId} and external_type = ${item.externalType} and external_id = ${item.externalId}`,
  );
  await upsertExternalRef(tx, connectionId, item, projectId);
  return existing.rows.length === 0 || existing.rows[0]!.external_version !== (item.externalVersion ?? null);
}

/** Active bindings that have at least one sync stream, for the poller and for webhook re-fetch. */
export async function syncTargets(db: Db, connectionId?: string) {
  const roles = [...new Set(SYNC_STREAMS.map((s) => s.role))];
  const rows = await db
    .select({
      bindingId: projectBindings.id,
      role: projectBindings.role,
      connectionId: projectBindings.connectionId,
    })
    .from(projectBindings)
    .innerJoin(connections, eq(connections.id, projectBindings.connectionId))
    .where(
      and(
        isNull(projectBindings.endedAt),
        inArray(projectBindings.role, roles),
        sql`${connections.status} <> 'retired'`,
        connectionId ? eq(projectBindings.connectionId, connectionId) : undefined,
      ),
    );
  return rows.flatMap((r) => streamsForRole(r.role).map((s) => ({ bindingId: r.bindingId, stream: s.name })));
}

export async function listSyncRuns(db: Db, projectId: string, limit = 50) {
  const rows = await db
    .select({ run: syncRuns })
    .from(syncRuns)
    .innerJoin(projectBindings, eq(projectBindings.id, syncRuns.bindingId))
    .where(eq(projectBindings.projectId, projectId))
    .orderBy(desc(syncRuns.startedAt))
    .limit(limit);
  return rows.map(({ run }) => ({
    id: run.id,
    bindingId: run.bindingId,
    stream: run.stream,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    pages: run.pages,
    itemsSeen: run.itemsSeen,
    itemsChanged: run.itemsChanged,
    errorKind: run.errorKind,
  }));
}
