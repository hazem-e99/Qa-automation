import { and, appendAudit, desc, eq, isNull, projectBindings, type Db } from '@qos/db';
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
