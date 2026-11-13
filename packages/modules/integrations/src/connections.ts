import {
  and,
  appendAudit,
  connectionCapabilities,
  connectionChecks,
  connections,
  desc,
  eq,
  externalRefs,
  sql,
  type Db,
  type Tx,
} from '@qos/db';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import type { Logger } from '@qos/observability';
import {
  capabilityDiff,
  ProviderError,
  type AuthStrategy,
  type BindingRole,
  type CapabilityDiff,
  type CapabilityId,
  type ConnectionContext,
  type ConnectionTestResult,
  type OutboundHttp,
  type ProviderFamily,
  type SecretStore,
} from '@qos/ports';
import type { ProviderRegistry } from './registry.js';

export type ConnectionStatus = 'untested' | 'active' | 'degraded' | 'auth_failed' | 'retired';

/** What callers see of a connection. There is deliberately no field that could hold the credential. */
export interface ConnectionView {
  readonly id: string;
  readonly providerType: string;
  readonly family: ProviderFamily;
  readonly displayName: string;
  readonly baseUrl: string | null;
  readonly authStrategy: AuthStrategy;
  readonly hasCredential: boolean;
  readonly status: ConnectionStatus;
  readonly isDemo: boolean;
  readonly lastTestedAt: string | null;
  readonly credentialExpiresAt: string | null;
}

export interface CapabilityView {
  readonly capability: CapabilityId;
  readonly ok: boolean;
  readonly detail: string | null;
}

export interface IntegrationDeps {
  readonly db: Db;
  readonly registry: ProviderRegistry;
  /** Null when no master key is configured: connections that need a credential cannot be created. */
  readonly secrets: SecretStore<Tx> | null;
  readonly http: OutboundHttp;
  readonly logger: Logger;
}

export interface Actor {
  readonly orgId: string;
  /** User id, or the job name when `system` is set. */
  readonly userId: string;
  /** Set for scheduled jobs (audit actor type `system`, source `worker`). */
  readonly system?: boolean;
}

type Row = typeof connections.$inferSelect;
const view = (r: Row): ConnectionView => ({
  id: r.id,
  providerType: r.providerType,
  family: r.family as ProviderFamily,
  displayName: r.displayName,
  baseUrl: r.baseUrl,
  authStrategy: r.authStrategy as AuthStrategy,
  hasCredential: r.secretRef !== null,
  status: r.status as ConnectionStatus,
  isDemo: r.isDemo,
  lastTestedAt: r.lastTestedAt?.toISOString() ?? null,
  credentialExpiresAt: r.credentialExpiresAt?.toISOString() ?? null,
});

async function load(db: Db | Tx, actor: Actor, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.orgId, actor.orgId)));
  if (!row) throw new DomainError('connection.not_found');
  return row;
}

export interface CreateConnectionInput {
  readonly providerType: string;
  readonly displayName: string;
  readonly authStrategy: AuthStrategy;
  readonly baseUrl?: string | null;
  /** Write-only. Stored in the SecretStore; never returned, logged or audited. */
  readonly credential?: string | null;
}

function checkBaseUrl(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError('connection.base_url_invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new DomainError('connection.base_url_invalid');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export async function createConnection(
  deps: IntegrationDeps,
  actor: Actor,
  input: CreateConnectionInput,
): Promise<ConnectionView> {
  if (!deps.registry.has(input.providerType)) throw new DomainError('connection.provider_unknown');
  const manifest = deps.registry.get(input.providerType).manifest();
  if (!manifest.authStrategies.includes(input.authStrategy))
    throw new DomainError('connection.auth_strategy_invalid');
  const displayName = input.displayName.trim();
  if (displayName.length < 2 || displayName.length > 80) throw new DomainError('connection.name_invalid');
  const needsCredential = input.authStrategy !== 'none';
  if (needsCredential && !input.credential) throw new DomainError('connection.credential_required');
  if (needsCredential && !deps.secrets) throw new DomainError('secrets.unavailable');
  const baseUrl = checkBaseUrl(input.baseUrl);

  return deps.db.transaction(async (tx) => {
    const taken = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.orgId, actor.orgId), eq(connections.displayName, displayName)));
    if (taken.length) throw new DomainError('connection.name_taken');
    const id = uuidv7();
    const secretRef =
      needsCredential && deps.secrets
        ? await deps.secrets.put(
            { ownerType: 'connection', ownerId: id, purpose: input.authStrategy, value: input.credential! },
            tx,
          )
        : null;
    const now = new Date();
    const [row] = await tx
      .insert(connections)
      .values({
        id,
        orgId: actor.orgId,
        providerType: manifest.providerType,
        family: manifest.family,
        displayName,
        baseUrl,
        authStrategy: input.authStrategy,
        secretRef,
        status: 'untested',
        isDemo: manifest.demoOnly === true,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'connection.created',
      targetType: 'connection',
      targetId: id,
      // Never the credential: only that one was supplied.
      summary: {
        providerType: manifest.providerType,
        authStrategy: input.authStrategy,
        credential: needsCredential,
      },
      source: 'api',
    });
    return view(row!);
  });
}

export async function getConnection(db: Db, actor: Actor, id: string): Promise<ConnectionView> {
  return view(await load(db, actor, id));
}

export async function listConnections(db: Db, actor: Actor): Promise<ConnectionView[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(eq(connections.orgId, actor.orgId))
    .orderBy(connections.displayName);
  return rows.map(view);
}

export function contextFor(deps: IntegrationDeps, row: Row): ConnectionContext {
  return {
    connectionId: row.id,
    baseUrl: row.baseUrl,
    http: deps.http,
    secret: async () => {
      if (!row.secretRef || !deps.secrets) throw new ProviderError('auth_failed', 'no credential configured');
      return deps.secrets.get(row.secretRef);
    },
    log: deps.logger.child({ connectionId: row.id, providerType: row.providerType }),
    now: () => new Date(),
  };
}

export interface TestOutcome {
  readonly connection: ConnectionView;
  readonly ok: boolean;
  readonly errorKind: string | null;
  readonly capabilities: readonly CapabilityView[];
}

/**
 * Runs the adapter's connection test and stores the effective capabilities
 * (manifest ∩ permission checks; doc 11 §5). A failure is stored as a normalized error kind only.
 */
export async function testConnection(deps: IntegrationDeps, actor: Actor, id: string): Promise<TestOutcome> {
  const row = await load(deps.db, actor, id);
  if (row.status === 'retired') throw new DomainError('connection.retired');
  const adapter = deps.registry.get(row.providerType);
  const declared = adapter.manifest().capabilities;
  let result: ConnectionTestResult | null = null;
  let errorKind: string | null = null;
  try {
    result = await adapter.testConnection(contextFor(deps, row));
  } catch (e) {
    errorKind = e instanceof ProviderError ? e.kind : 'unknown';
    deps.logger.warn({ connectionId: id, errorKind }, 'connection test failed');
  }
  const checks = new Map(result?.permissionChecks.map((c) => [c.capability, c]) ?? []);
  const capabilities: CapabilityView[] = declared.map((capability) => {
    const c = checks.get(capability);
    const ok = result !== null && c?.ok === true;
    return { capability, ok, detail: ok ? null : (c?.missing ?? (result ? 'not confirmed' : errorKind)) };
  });
  const status: ConnectionStatus =
    errorKind === 'auth_failed' || errorKind === 'permission_denied'
      ? 'auth_failed'
      : result === null
        ? 'degraded'
        : capabilities.every((c) => c.ok)
          ? 'active'
          : 'degraded';

  const updated = await deps.db.transaction(async (tx) => {
    await tx.delete(connectionCapabilities).where(eq(connectionCapabilities.connectionId, id));
    if (capabilities.length) {
      await tx.insert(connectionCapabilities).values(
        capabilities.map((c) => ({
          connectionId: id,
          capability: c.capability,
          ok: c.ok,
          detail: c.detail,
        })),
      );
    }
    const now = new Date();
    await tx.insert(connectionChecks).values({
      id: uuidv7(),
      connectionId: id,
      ok: result !== null,
      result: result
        ? { identity: result.identity, scopes: result.scopesDiscovered, checks: result.permissionChecks }
        : { errorKind },
      createdAt: now,
    });
    const [u] = await tx
      .update(connections)
      .set({
        status,
        lastTestedAt: now,
        updatedAt: now,
        credentialExpiresAt: result?.expiresAt ? new Date(result.expiresAt) : null,
      })
      .where(eq(connections.id, id))
      .returning();
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: actor.system ? 'system' : 'user',
      actorId: actor.userId,
      action: 'connection.tested',
      targetType: 'connection',
      targetId: id,
      summary: { status, errorKind, okCapabilities: capabilities.filter((c) => c.ok).length },
      source: actor.system ? 'worker' : 'api',
    });
    return u!;
  });
  return { connection: view(updated), ok: result !== null, errorKind, capabilities };
}

export async function listCapabilities(db: Db, actor: Actor, id: string): Promise<CapabilityView[]> {
  await load(db, actor, id);
  const rows = await db
    .select()
    .from(connectionCapabilities)
    .where(eq(connectionCapabilities.connectionId, id))
    .orderBy(connectionCapabilities.capability);
  return rows.map((r) => ({ capability: r.capability as CapabilityId, ok: r.ok, detail: r.detail }));
}

export async function listChecks(db: Db, actor: Actor, id: string, limit = 20) {
  await load(db, actor, id);
  const rows = await db
    .select()
    .from(connectionChecks)
    .where(eq(connectionChecks.connectionId, id))
    .orderBy(desc(connectionChecks.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ok: r.ok, result: r.result, createdAt: r.createdAt.toISOString() }));
}

/**
 * Can this connection serve a role? (BR-M02-2, M03-AC-01). Uses the effective capabilities from
 * the last test, so an untested connection never qualifies.
 */
export async function checkConnectionForRole(
  db: Db,
  actor: Actor,
  id: string,
  role: BindingRole,
): Promise<CapabilityDiff> {
  const row = await load(db, actor, id);
  const effective = (await listCapabilities(db, actor, id)).filter((c) => c.ok).map((c) => c.capability);
  const diff = capabilityDiff(role, row.family as ProviderFamily, effective);
  return row.status === 'retired' ? { ...diff, ok: false } : diff;
}

/** Replaces the credential. The connection must be tested again before it counts as healthy. */
export async function rotateCredential(
  deps: IntegrationDeps,
  actor: Actor,
  id: string,
  credential: string,
): Promise<ConnectionView> {
  if (!deps.secrets) throw new DomainError('secrets.unavailable');
  if (!credential) throw new DomainError('connection.credential_required');
  return deps.db.transaction(async (tx) => {
    const row = await load(tx, actor, id);
    if (row.status === 'retired') throw new DomainError('connection.retired');
    if (row.authStrategy === 'none') throw new DomainError('connection.auth_strategy_invalid');
    let secretRef = row.secretRef;
    if (secretRef) await deps.secrets!.rotate(secretRef, credential, tx);
    else
      secretRef = await deps.secrets!.put(
        { ownerType: 'connection', ownerId: id, purpose: row.authStrategy, value: credential },
        tx,
      );
    const [u] = await tx
      .update(connections)
      .set({ secretRef, status: 'untested', credentialExpiresAt: null, updatedAt: new Date() })
      .where(eq(connections.id, id))
      .returning();
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'connection.secret_rotated',
      targetType: 'connection',
      targetId: id,
      summary: {},
      source: 'api',
    });
    return view(u!);
  });
}

/**
 * Retires a connection (doc 11 §6). History is never rewritten: its ExternalRefs stay readable
 * from their snapshots and are labelled `source_retired` (M03-AC-05). The credential is destroyed.
 */
export async function retireConnection(
  deps: IntegrationDeps,
  actor: Actor,
  id: string,
): Promise<ConnectionView> {
  return deps.db.transaction(async (tx) => {
    const row = await load(tx, actor, id);
    if (row.status === 'retired') throw new DomainError('connection.retired');
    if (row.secretRef && deps.secrets) await deps.secrets.delete(row.secretRef, tx);
    const refs = await tx
      .update(externalRefs)
      .set({ status: 'source_retired' })
      .where(and(eq(externalRefs.connectionId, id), eq(externalRefs.status, 'live')))
      .returning({ id: externalRefs.id });
    const [u] = await tx
      .update(connections)
      .set({ status: 'retired', secretRef: null, updatedAt: new Date() })
      .where(eq(connections.id, id))
      .returning();
    await appendAudit(tx, {
      orgId: actor.orgId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'connection.retired',
      targetType: 'connection',
      targetId: id,
      summary: { externalRefsRetired: refs.length },
      source: 'api',
    });
    return view(u!);
  });
}

/** How much history depends on this connection (shown before retiring it). */
export async function connectionImpact(db: Db, actor: Actor, id: string) {
  await load(db, actor, id);
  const res = await db.execute<{ external_type: string; n: number }>(
    sql`select external_type, count(*)::int as n from integrations.external_refs
        where connection_id = ${id} group by external_type order by external_type`,
  );
  return { externalRefs: Object.fromEntries(res.rows.map((r) => [r.external_type, r.n])) };
}

/** Connections whose credential expires within `withinDays` (or already has). Retired ones are ignored. */
export async function expiringConnections(db: Db, now: Date = new Date(), withinDays = 14) {
  const limit = new Date(now.getTime() + withinDays * 86_400_000);
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        sql`${connections.status} <> 'retired'`,
        sql`${connections.credentialExpiresAt} is not null`,
        sql`${connections.credentialExpiresAt} <= ${limit}`,
      ),
    );
  return rows.map((r) => ({ ...view(r), orgId: r.orgId, credentialExpiresAt: r.credentialExpiresAt! }));
}
