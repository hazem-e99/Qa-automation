import { and, appendAudit, connections, eq, valueMappings, type Db } from '@qos/db';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import { ProviderError, type IssueTracker } from '@qos/ports';
import { contextFor, listCapabilities, type Actor, type IntegrationDeps } from './connections.js';
import {
  CANONICAL_VALUES,
  lintMapping,
  MAPPING_KINDS,
  suggestMapping,
  type LintResult,
  type MappingEntry,
  type MappingKind,
} from './mapping-lint.js';

/**
 * Value mappings of a tracker binding (T-P2-32, M03-FR-07/13). The caller (API) resolves the
 * project and binding; this module stores mappings, discovers external values through the
 * binding's connection, and lints.
 */
export interface MappingView {
  readonly kind: MappingKind;
  readonly entries: MappingEntry[];
  readonly canonical: readonly string[];
  readonly discovered: string[] | null;
  readonly discoveredAt: string | null;
  readonly version: number;
  readonly lint: LintResult;
}
export interface BindingRefs {
  readonly projectId: string;
  readonly bindingId: string;
  readonly connectionId: string;
}
type Row = typeof valueMappings.$inferSelect;

const view = (kind: MappingKind, row: Row | undefined): MappingView => {
  const entries = (row?.entries as MappingEntry[] | undefined) ?? [];
  const discovered = (row?.discovered as string[] | null | undefined) ?? null;
  return {
    kind,
    entries,
    canonical: CANONICAL_VALUES[kind],
    discovered,
    discoveredAt: row?.discoveredAt?.toISOString() ?? null,
    version: row?.version ?? 0,
    lint: lintMapping(kind, entries, discovered),
  };
};

export async function listMappings(db: Db, bindingId: string): Promise<MappingView[]> {
  const rows = await db.select().from(valueMappings).where(eq(valueMappings.bindingId, bindingId));
  return MAPPING_KINDS.map((k) =>
    view(
      k,
      rows.find((r) => r.kind === k),
    ),
  );
}

export async function getMapping(db: Db, bindingId: string, kind: MappingKind): Promise<MappingView> {
  const [row] = await db
    .select()
    .from(valueMappings)
    .where(and(eq(valueMappings.bindingId, bindingId), eq(valueMappings.kind, kind)));
  return view(kind, row);
}

function cleanEntries(raw: readonly MappingEntry[]): MappingEntry[] {
  if (raw.length > 200) throw new DomainError('mapping.too_large');
  return raw.map((e) => {
    const external = String(e.external ?? '').trim();
    const canonical = String(e.canonical ?? '').trim();
    if (external.length > 200 || canonical.length > 60) throw new DomainError('mapping.value_too_long');
    return { external, canonical };
  });
}

/**
 * Saves a mapping with optimistic concurrency. A mapping with lint errors may be saved (work in
 * progress); activation is what requires a clean lint (BR-M03-6).
 */
export async function saveMapping(
  db: Db,
  actor: Actor,
  refs: BindingRefs,
  kind: MappingKind,
  input: { expectedVersion: number; entries: readonly MappingEntry[] },
): Promise<MappingView> {
  const entries = cleanEntries(input.entries);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(valueMappings)
      .where(and(eq(valueMappings.bindingId, refs.bindingId), eq(valueMappings.kind, kind)))
      .for('update');
    const currentVersion = current?.version ?? 0;
    if (input.expectedVersion !== currentVersion)
      throw new DomainError('mapping.version_conflict', { currentVersion });
    const now = new Date();
    const [row] = current
      ? await tx
          .update(valueMappings)
          .set({ entries, version: currentVersion + 1, updatedBy: actor.userId, updatedAt: now })
          .where(eq(valueMappings.id, current.id))
          .returning()
      : await tx
          .insert(valueMappings)
          .values({
            id: uuidv7(),
            projectId: refs.projectId,
            bindingId: refs.bindingId,
            kind,
            entries,
            version: 1,
            updatedBy: actor.userId,
            updatedAt: now,
          })
          .returning();
    const result = view(kind, row);
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: refs.projectId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'mapping.saved',
      targetType: 'binding',
      targetId: refs.bindingId,
      summary: { kind, version: result.version, entries: entries.length, lintOk: result.lint.ok },
      source: 'api',
    });
    return result;
  });
}

const isTracker = (a: unknown): a is IssueTracker =>
  typeof (a as { getMetadata?: unknown }).getMetadata === 'function';

/**
 * Reads types, states, priorities and severities from the provider and records them as the
 * discovered values of each kind. Kinds with no entries yet get a suggested mapping (version 1),
 * which people review before activating anything.
 */
export async function discoverMappings(
  deps: IntegrationDeps,
  actor: Actor,
  refs: BindingRefs,
): Promise<MappingView[]> {
  const [conn] = await deps.db
    .select()
    .from(connections)
    .where(and(eq(connections.id, refs.connectionId), eq(connections.orgId, actor.orgId)));
  if (!conn) throw new DomainError('connection.not_found');
  if (conn.status === 'retired') throw new DomainError('connection.retired');
  const adapter = deps.registry.get(conn.providerType);
  const effective = (await listCapabilities(deps.db, actor, conn.id))
    .filter((c) => c.ok)
    .map((c) => c.capability);
  if (!isTracker(adapter) || !effective.includes('issues.metadata.read@1')) {
    throw new DomainError('mapping.discovery_unsupported', { capability: 'issues.metadata.read@1' });
  }
  let meta;
  try {
    meta = await adapter.getMetadata(contextFor(deps, conn), {});
  } catch (e) {
    throw new DomainError('mapping.discovery_failed', {
      kind: e instanceof ProviderError ? e.kind : 'unknown',
    });
  }
  const values: Record<MappingKind, string[]> = {
    status: meta.states.map((s) => s.name),
    severity: [...meta.severities],
    priority: [...meta.priorities],
    type: [...meta.types],
  };
  const categories = Object.fromEntries(meta.states.map((s) => [s.name, s.category]));
  await deps.db.transaction(async (tx) => {
    const now = new Date();
    for (const kind of MAPPING_KINDS) {
      const [current] = await tx
        .select()
        .from(valueMappings)
        .where(and(eq(valueMappings.bindingId, refs.bindingId), eq(valueMappings.kind, kind)))
        .for('update');
      const discovered = values[kind];
      if (current) {
        const empty = (current.entries as MappingEntry[]).length === 0;
        await tx
          .update(valueMappings)
          .set({
            discovered,
            discoveredAt: now,
            ...(empty
              ? {
                  entries: suggestMapping(kind, discovered, categories),
                  version: current.version + 1,
                  updatedBy: actor.userId,
                  updatedAt: now,
                }
              : {}),
          })
          .where(eq(valueMappings.id, current.id));
      } else {
        await tx.insert(valueMappings).values({
          id: uuidv7(),
          projectId: refs.projectId,
          bindingId: refs.bindingId,
          kind,
          entries: suggestMapping(kind, discovered, categories),
          discovered,
          discoveredAt: now,
          version: 1,
          updatedBy: actor.userId,
          updatedAt: now,
        });
      }
    }
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: refs.projectId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'mapping.discovered',
      targetType: 'binding',
      targetId: refs.bindingId,
      summary: { states: values.status.length, types: values.type.length },
      source: 'api',
    });
  });
  return listMappings(deps.db, refs.bindingId);
}

/**
 * BR-M03-6 / M03-AC-09: defect sync can be activated only after discovery and with a status
 * mapping that covers every discovered external status.
 */
export async function assertStatusMappingComplete(db: Db, bindingId: string): Promise<void> {
  const status = await getMapping(db, bindingId, 'status');
  if (!status.discovered) throw new DomainError('mapping.not_discovered');
  if (!status.lint.ok) {
    const unmapped = status.lint.issues.filter((i) => i.code === 'unmapped_external').map((i) => i.value);
    const other = status.lint.issues
      .filter((i) => i.severity === 'error' && i.code !== 'unmapped_external')
      .map((i) => `${i.code}:${i.value}`);
    throw new DomainError('mapping.incomplete', { unmapped: unmapped.join(','), errors: other.join(',') });
  }
}
