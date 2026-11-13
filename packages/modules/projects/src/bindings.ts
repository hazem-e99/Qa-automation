import { and, appendAudit, desc, eq, isNull, projectBindings, sql, type Db } from '@qos/db';
import type { Principal } from '@qos/identity';
import { checkConnectionForRole, getConnection } from '@qos/integrations';
import { appendOutbox } from '@qos/jobs';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import type { BindingRole } from '@qos/ports';
import { assertProjectWritable, type Project } from './projects.js';

/** Roles that may have several active bindings (BR-M02-4). */
export const MULTI_BINDING_ROLES: readonly string[] = ['requirements', 'notifications'];

export interface Binding {
  readonly id: string;
  readonly role: string;
  readonly connectionId: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly mode: 'active' | 'legacy_sync';
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly warnings: readonly string[];
}

type Row = typeof projectBindings.$inferSelect;
const view = (r: Row, warnings: readonly string[] = []): Binding => ({
  id: r.id,
  role: r.role,
  connectionId: r.connectionId,
  config: r.config as Record<string, unknown>,
  mode: r.mode as Binding['mode'],
  startedAt: r.startedAt.toISOString(),
  endedAt: r.endedAt?.toISOString() ?? null,
  warnings,
});

const MAX_CONFIG_BYTES = 8 * 1024;

/**
 * Binds a connection to a role (BR-M02-2/3/4). Required capabilities must be confirmed by the
 * last connection test; missing optional ones are returned as warnings. For single-binding roles
 * the previous binding is ended, never deleted, so history and ExternalRefs stay intact.
 */
export async function bindConnection(
  db: Db,
  actor: Principal,
  project: Project,
  input: { role: BindingRole; connectionId: string; config?: Record<string, unknown> },
): Promise<Binding> {
  assertProjectWritable(project);
  const config = input.config ?? {};
  if (JSON.stringify(config).length > MAX_CONFIG_BYTES) throw new DomainError('binding.config_too_large');
  const orgActor = { orgId: actor.orgId, userId: actor.userId };
  const connection = await getConnection(db, orgActor, input.connectionId).catch(() => {
    throw new DomainError('connection.not_found');
  });
  // Demo connections may only serve demo projects (doc 11 §8).
  if (connection.isDemo && !project.isDemo) throw new DomainError('binding.demo_connection');
  const diff = await checkConnectionForRole(db, orgActor, input.connectionId, input.role);
  if (!diff.ok) {
    // M02-AC-02: the refusal lists exactly what is missing.
    throw new DomainError('binding.capabilities_missing', {
      role: input.role,
      missing: [...diff.missingRequired, ...diff.missingAnyOf.map((g) => g.join('|'))].join(','),
      familyMismatch: diff.familyMismatch,
      status: connection.status,
    });
  }
  return db.transaction(async (tx) => {
    const now = new Date();
    const active = await tx
      .select()
      .from(projectBindings)
      .where(
        and(
          eq(projectBindings.projectId, project.id),
          eq(projectBindings.role, input.role),
          isNull(projectBindings.endedAt),
        ),
      );
    if (active.some((b) => b.connectionId === input.connectionId))
      throw new DomainError('binding.already_bound');
    if (!MULTI_BINDING_ROLES.includes(input.role)) {
      for (const old of active) {
        await tx
          .update(projectBindings)
          .set({ endedAt: now, endedBy: actor.userId })
          .where(and(eq(projectBindings.id, old.id), isNull(projectBindings.endedAt)));
      }
    }
    const [row] = await tx
      .insert(projectBindings)
      .values({
        id: uuidv7(),
        projectId: project.id,
        role: input.role,
        connectionId: input.connectionId,
        config,
        mode: 'active',
        startedAt: now,
        startedBy: actor.userId,
      })
      .returning();
    const replaced = MULTI_BINDING_ROLES.includes(input.role) ? [] : active.map((b) => b.connectionId);
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: actor.userId,
      action: 'project.binding.changed',
      targetType: 'binding',
      targetId: row!.id,
      summary: {
        role: input.role,
        connectionId: input.connectionId,
        replaced,
        warnings: diff.missingOptional,
      },
      source: 'api',
    });
    await appendOutbox(tx, {
      type: 'project.binding.changed',
      aggregateType: 'project',
      aggregateId: project.id,
      projectId: project.id,
      payload: { role: input.role, bindingId: row!.id, connectionId: input.connectionId, replaced },
    });
    return view(row!, diff.missingOptional);
  });
}

export async function endBinding(
  db: Db,
  actor: Principal,
  project: Project,
  bindingId: string,
): Promise<void> {
  assertProjectWritable(project);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(projectBindings)
      .set({ endedAt: new Date(), endedBy: actor.userId })
      .where(
        and(
          eq(projectBindings.id, bindingId),
          eq(projectBindings.projectId, project.id),
          isNull(projectBindings.endedAt),
        ),
      )
      .returning();
    if (!row) throw new DomainError('binding.not_found');
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: actor.userId,
      action: 'project.binding.ended',
      targetType: 'binding',
      targetId: bindingId,
      summary: { role: row.role, connectionId: row.connectionId },
      source: 'api',
    });
    await appendOutbox(tx, {
      type: 'project.binding.changed',
      aggregateType: 'project',
      aggregateId: project.id,
      projectId: project.id,
      payload: { role: row.role, bindingId, connectionId: row.connectionId, ended: true },
    });
  });
}

/** Active bindings, or the full history including ended ones. */
export async function listBindings(
  db: Db,
  project: Project,
  opts: { history?: boolean } = {},
): Promise<Binding[]> {
  const rows = await db
    .select()
    .from(projectBindings)
    .where(
      opts.history
        ? eq(projectBindings.projectId, project.id)
        : and(eq(projectBindings.projectId, project.id), isNull(projectBindings.endedAt)),
    )
    .orderBy(projectBindings.role, desc(projectBindings.startedAt));
  return rows.map((r) => view(r));
}

export interface BindingHealth {
  readonly bindingId: string;
  readonly role: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly connectionStatus: string;
  readonly lastTestedAt: string | null;
  /** True when the last connection test confirms every required capability of the role. */
  readonly ok: boolean;
  readonly missingRequired: readonly string[];
  readonly missingOptional: readonly string[];
  readonly familyMismatch: boolean;
}

/**
 * Health of each active binding (T-P2-17): does the connection, as last tested, still serve the
 * role? Read-only; the scheduled check re-tests stale connections before computing this.
 */
export async function bindingHealth(db: Db, project: Project): Promise<BindingHealth[]> {
  const orgActor = { orgId: project.orgId, userId: 'bindings.health' };
  const out: BindingHealth[] = [];
  for (const b of await listBindings(db, project)) {
    const connection = await getConnection(db, orgActor, b.connectionId);
    const diff = await checkConnectionForRole(db, orgActor, b.connectionId, b.role as BindingRole);
    out.push({
      bindingId: b.id,
      role: b.role,
      connectionId: b.connectionId,
      connectionName: connection.displayName,
      connectionStatus: connection.status,
      lastTestedAt: connection.lastTestedAt,
      ok: diff.ok,
      missingRequired: [...diff.missingRequired, ...diff.missingAnyOf.map((g) => g.join('|'))],
      missingOptional: [...diff.missingOptional],
      familyMismatch: diff.familyMismatch,
    });
  }
  return out;
}

/** Active bindings of every live project, for the scheduled health check. */
export async function activeBindingsForHealthCheck(
  db: Db,
): Promise<{ projectId: string; orgId: string; projectKey: string; connectionId: string }[]> {
  const res = await db.execute<{
    project_id: string;
    org_id: string;
    key: string;
    connection_id: string;
  }>(sql`
    select b.project_id, p.org_id, p.key, b.connection_id
    from projects.project_bindings b
    join projects.projects p on p.id = b.project_id and p.status in ('draft', 'active')
    where b.ended_at is null`);
  return res.rows.map((r) => ({
    projectId: r.project_id,
    orgId: r.org_id,
    projectKey: r.key,
    connectionId: r.connection_id,
  }));
}

/** Active bindings that use a connection, for the retire impact view (T-P2-33). */
export async function bindingsUsingConnection(
  db: Db,
  orgId: string,
  connectionId: string,
): Promise<{ projectKey: string; projectName: string; role: string }[]> {
  const res = await db.execute<{ key: string; name: string; role: string }>(sql`
    select p.key, p.name, b.role
    from projects.project_bindings b
    join projects.projects p on p.id = b.project_id and p.org_id = ${orgId} and p.status <> 'deleted'
    where b.connection_id = ${connectionId} and b.ended_at is null
    order by p.key, b.role`);
  return res.rows.map((r) => ({ projectKey: r.key, projectName: r.name, role: r.role }));
}

/** One active binding of the project, or a 404-style error. */
export async function getActiveBinding(db: Db, project: Project, bindingId: string): Promise<Binding> {
  if (!/^[0-9a-f-]{36}$/i.test(bindingId)) throw new DomainError('binding.not_found');
  const [row] = await db
    .select()
    .from(projectBindings)
    .where(
      and(
        eq(projectBindings.id, bindingId),
        eq(projectBindings.projectId, project.id),
        isNull(projectBindings.endedAt),
      ),
    );
  if (!row) throw new DomainError('binding.not_found');
  return view(row);
}

/**
 * Turns defect sync on or off for an issue-tracker binding (`config.defectSync`). The caller
 * checks the preconditions (complete status mapping, BR-M03-6) before enabling. Audited.
 */
export async function setDefectSync(
  db: Db,
  actor: Principal,
  project: Project,
  bindingId: string,
  enabled: boolean,
): Promise<Binding> {
  assertProjectWritable(project);
  const current = await getActiveBinding(db, project, bindingId);
  if (current.role !== 'issue_tracker') throw new DomainError('binding.role_invalid', { role: current.role });
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(projectBindings)
      .set({ config: { ...current.config, defectSync: enabled } })
      .where(eq(projectBindings.id, bindingId))
      .returning();
    await appendAudit(tx, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: actor.userId,
      action: enabled ? 'binding.defect_sync.enabled' : 'binding.defect_sync.disabled',
      targetType: 'binding',
      targetId: bindingId,
      summary: { role: current.role },
      source: 'api',
    });
    return view(row!);
  });
}
