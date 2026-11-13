import { appendAudit } from '@qos/db';
import { listOrgAdmins, listProjectMembers } from '@qos/identity';
import { getConnection, testConnection, type IntegrationDeps } from '@qos/integrations';
import { activeBindingsForHealthCheck, bindingHealth, findProjectByKey } from '@qos/projects';
import { notify } from './notifications.js';

export interface BindingsHealthResult {
  readonly tested: number;
  readonly testFailures: number;
  readonly unhealthy: number;
  readonly notified: number;
}

const JOB = 'bindings.health-check';

/**
 * Scheduled bindings health check (T-P2-17).
 *  1. Re-tests every bound connection whose last test is older than `staleHours`.
 *  2. Recomputes each binding's capability check from that result.
 *  3. For a binding that no longer serves its role, the project's QA leads and the org admins
 *     get one in-app notification per binding per UTC day, with one audit entry that day.
 * Safe to run as often as wanted: notifications are deduplicated per day.
 */
export async function checkBindingsHealth(
  deps: IntegrationDeps,
  opts: { now?: Date; staleHours?: number } = {},
): Promise<BindingsHealthResult> {
  const now = opts.now ?? new Date();
  const staleMs = (opts.staleHours ?? 6) * 3_600_000;
  const day = now.toISOString().slice(0, 10);
  const bound = await activeBindingsForHealthCheck(deps.db);

  let tested = 0;
  let testFailures = 0;
  const seen = new Set<string>();
  for (const b of bound) {
    if (seen.has(b.connectionId)) continue;
    seen.add(b.connectionId);
    const actor = { orgId: b.orgId, userId: JOB, system: true };
    try {
      const c = await getConnection(deps.db, actor, b.connectionId);
      if (c.status === 'retired') continue;
      const last = c.lastTestedAt ? Date.parse(c.lastTestedAt) : 0;
      if (now.getTime() - last < staleMs) continue;
      await testConnection(deps, actor, b.connectionId);
      tested++;
    } catch (err) {
      testFailures++;
      deps.logger.warn({ err, connectionId: b.connectionId }, 'binding health: connection test failed');
    }
  }

  let unhealthy = 0;
  let notified = 0;
  const projects = new Map<string, { orgId: string; key: string }>();
  for (const b of bound) projects.set(b.projectId, { orgId: b.orgId, key: b.projectKey });
  for (const [projectId, { orgId, key }] of projects) {
    const project = await findProjectByKey(deps.db, orgId, key);
    if (!project) continue;
    const bad = (await bindingHealth(deps.db, project)).filter((h) => !h.ok);
    if (!bad.length) continue;
    unhealthy += bad.length;
    await deps.db.transaction(async (tx) => {
      const leads = (await listProjectMembers(tx, projectId))
        .filter((m) => m.role === 'qa_lead')
        .map((m) => m.userId);
      const recipients = [...new Set([...leads, ...(await listOrgAdmins(tx, orgId))])];
      for (const h of bad) {
        let created = 0;
        for (const userId of recipients) {
          const isNew = await notify(tx, {
            userId,
            projectId,
            type: 'binding.unhealthy',
            payload: {
              projectKey: key,
              role: h.role,
              connectionId: h.connectionId,
              connectionName: h.connectionName,
              connectionStatus: h.connectionStatus,
              missing: h.missingRequired.join(','),
            },
            dedupeKey: `binding.unhealthy:${h.bindingId}:${day}`,
          });
          if (isNew) created++;
        }
        if (created > 0) {
          notified += created;
          await appendAudit(tx, {
            orgId,
            projectId,
            actorType: 'system',
            actorId: JOB,
            action: 'binding.unhealthy',
            targetType: 'binding',
            targetId: h.bindingId,
            summary: { role: h.role, connectionStatus: h.connectionStatus, missing: h.missingRequired, day },
            source: 'worker',
          });
        }
      }
    });
  }
  return { tested, testFailures, unhealthy, notified };
}
