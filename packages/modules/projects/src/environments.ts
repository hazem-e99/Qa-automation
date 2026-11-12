import { isIP } from 'node:net';
import { and, appendAudit, eq, projectEnvironments, type Db, type Tx } from '@qos/db';
import type { Principal } from '@qos/identity';
import { appendOutbox } from '@qos/jobs';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import type { SecretStore } from '@qos/ports';
import { assertProjectWritable, type Project } from './projects.js';

export interface Environment {
  readonly id: string;
  readonly name: string;
  readonly baseUrls: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly isProduction: boolean;
  /** Whether test login data is stored. The value itself is never exposed. */
  readonly hasAuthSecret: boolean;
  readonly authSecretUpdatedAt: string | null;
  readonly resetHookUrl: string | null;
  readonly tags: readonly string[];
}

export interface EnvironmentInput {
  readonly name: string;
  readonly baseUrls: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly isProduction?: boolean;
  /** Write-only. `undefined` keeps the current secret, `null` removes it. */
  readonly authSecret?: string | null;
  readonly resetHookUrl?: string | null;
  readonly tags?: readonly string[];
}

type Row = typeof projectEnvironments.$inferSelect;
const view = (r: Row): Environment => ({
  id: r.id,
  name: r.name,
  baseUrls: r.baseUrls,
  allowedHosts: r.allowedHosts,
  isProduction: r.isProduction,
  hasAuthSecret: r.authSecretRef !== null,
  authSecretUpdatedAt: r.authSecretUpdatedAt?.toISOString() ?? null,
  resetHookUrl: r.resetHookUrl,
  tags: r.tags,
});

const HOST_RE =
  /^(?=.{1,253}$)(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A host pattern: a lower-case DNS name, optionally `*.` for subdomains. IP literals are allowed. */
function normalizeHost(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/\.$/, '');
  if (isIP(host) || HOST_RE.test(host)) return host;
  throw new DomainError('environment.host_invalid', { host: raw.slice(0, 80) });
}

const hostAllowed = (host: string, allowed: readonly string[]) =>
  allowed.some((a) => (a.startsWith('*.') ? host.endsWith(a.slice(1)) && host !== a.slice(2) : host === a));

function parseUrl(raw: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError('environment.url_invalid', { field });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new DomainError('environment.url_invalid', { field });
  }
  return url;
}

/**
 * Normalizes and cross-checks an environment (M02-FR-03): every base URL host and the reset hook
 * host must be on the egress allow-list, because test runs may only reach allowed hosts. Hosts of
 * the base URLs are added to the allow-list when it is empty.
 */
function validate(input: EnvironmentInput) {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) throw new DomainError('environment.name_invalid');
  if (input.baseUrls.length < 1) throw new DomainError('environment.url_invalid', { field: 'baseUrls' });
  const baseUrls = input.baseUrls.map((u) => parseUrl(u, 'baseUrls'));
  const allowedHosts = [...new Set((input.allowedHosts ?? []).map(normalizeHost))];
  const effective = allowedHosts.length
    ? allowedHosts
    : [...new Set(baseUrls.map((u) => u.hostname.toLowerCase()))];
  for (const u of baseUrls) {
    if (!hostAllowed(u.hostname.toLowerCase(), effective)) {
      throw new DomainError('environment.host_not_allowed', { host: u.hostname });
    }
  }
  let resetHookUrl: string | null = null;
  if (input.resetHookUrl) {
    const hook = parseUrl(input.resetHookUrl, 'resetHookUrl');
    if (hook.protocol !== 'https:')
      throw new DomainError('environment.url_invalid', { field: 'resetHookUrl' });
    if (!hostAllowed(hook.hostname.toLowerCase(), effective)) {
      throw new DomainError('environment.host_not_allowed', { host: hook.hostname });
    }
    resetHookUrl = hook.href;
  }
  return {
    name,
    baseUrls: baseUrls.map((u) => u.href),
    allowedHosts: effective,
    isProduction: input.isProduction ?? false,
    resetHookUrl,
    tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20),
  };
}

export interface EnvironmentDeps {
  readonly db: Db;
  /** Needed only to store test login data. Null when no master key is configured. */
  readonly secrets: SecretStore<Tx> | null;
}

async function audit(
  tx: Tx,
  actor: Principal,
  project: Project,
  envId: string,
  action: string,
  summary: object,
) {
  await appendAudit(tx, {
    orgId: actor.orgId,
    projectId: project.id,
    actorType: 'user',
    actorId: actor.userId,
    action,
    targetType: 'environment',
    targetId: envId,
    summary: summary as Record<string, unknown>,
    source: 'api',
  });
  await appendOutbox(tx, {
    type: 'environment.changed',
    aggregateType: 'environment',
    aggregateId: envId,
    projectId: project.id,
    payload: { action },
  });
}

export async function listEnvironments(db: Db, project: Project): Promise<Environment[]> {
  const rows = await db
    .select()
    .from(projectEnvironments)
    .where(eq(projectEnvironments.projectId, project.id))
    .orderBy(projectEnvironments.name);
  return rows.map(view);
}

export async function createEnvironment(
  deps: EnvironmentDeps,
  actor: Principal,
  project: Project,
  input: EnvironmentInput,
): Promise<Environment> {
  assertProjectWritable(project);
  const v = validate(input);
  if (input.authSecret && !deps.secrets) throw new DomainError('secrets.unavailable');
  return deps.db.transaction(async (tx) => {
    const id = uuidv7();
    const taken = await tx
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .where(and(eq(projectEnvironments.projectId, project.id), eq(projectEnvironments.name, v.name)));
    if (taken.length) throw new DomainError('environment.name_taken');
    const now = new Date();
    const authSecretRef = input.authSecret
      ? await deps.secrets!.put(
          { ownerType: 'environment', ownerId: id, purpose: 'test_auth', value: input.authSecret },
          tx,
        )
      : null;
    const [row] = await tx
      .insert(projectEnvironments)
      .values({
        id,
        projectId: project.id,
        ...v,
        authSecretRef,
        authSecretUpdatedAt: authSecretRef ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await audit(tx, actor, project, id, 'environment.created', {
      name: v.name,
      isProduction: v.isProduction,
      authSecret: authSecretRef !== null,
    });
    return view(row!);
  });
}

export async function updateEnvironment(
  deps: EnvironmentDeps,
  actor: Principal,
  project: Project,
  id: string,
  input: EnvironmentInput,
): Promise<Environment> {
  assertProjectWritable(project);
  const v = validate(input);
  if (input.authSecret && !deps.secrets) throw new DomainError('secrets.unavailable');
  return deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(projectEnvironments)
      .where(and(eq(projectEnvironments.id, id), eq(projectEnvironments.projectId, project.id)));
    if (!current) throw new DomainError('environment.not_found');
    const clash = await tx
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .where(and(eq(projectEnvironments.projectId, project.id), eq(projectEnvironments.name, v.name)));
    if (clash.some((c) => c.id !== id)) throw new DomainError('environment.name_taken');
    const now = new Date();
    let authSecretRef = current.authSecretRef;
    let authSecretUpdatedAt = current.authSecretUpdatedAt;
    if (input.authSecret === null && authSecretRef) {
      await deps.secrets?.delete(authSecretRef, tx);
      authSecretRef = null;
      authSecretUpdatedAt = null;
    } else if (input.authSecret) {
      if (authSecretRef) await deps.secrets!.rotate(authSecretRef, input.authSecret, tx);
      else
        authSecretRef = await deps.secrets!.put(
          { ownerType: 'environment', ownerId: id, purpose: 'test_auth', value: input.authSecret },
          tx,
        );
      authSecretUpdatedAt = now;
    }
    const [row] = await tx
      .update(projectEnvironments)
      .set({ ...v, authSecretRef, authSecretUpdatedAt, updatedAt: now })
      .where(eq(projectEnvironments.id, id))
      .returning();
    await audit(tx, actor, project, id, 'environment.updated', {
      name: v.name,
      isProduction: v.isProduction,
      authSecretChanged: input.authSecret !== undefined,
    });
    return view(row!);
  });
}

export async function deleteEnvironment(
  deps: EnvironmentDeps,
  actor: Principal,
  project: Project,
  id: string,
): Promise<void> {
  assertProjectWritable(project);
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .delete(projectEnvironments)
      .where(and(eq(projectEnvironments.id, id), eq(projectEnvironments.projectId, project.id)))
      .returning();
    if (!row) throw new DomainError('environment.not_found');
    if (row.authSecretRef) await deps.secrets?.delete(row.authSecretRef, tx);
    await audit(tx, actor, project, id, 'environment.deleted', { name: row.name });
  });
}
