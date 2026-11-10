import { PROBE_CREATED_EVENT, type CreateProbeRequest, type ProbeCreatedPayload } from '@qos/contracts';
import { appendAudit, probes, type Db, type Tx } from '@qos/db';
import { appendOutbox, QUEUES } from '@qos/jobs';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import type { JobQueue } from '@qos/ports';

export interface ProbeDeps {
  readonly db: Db;
  readonly jobs: JobQueue<Tx>;
}

export interface ProbeJobData {
  readonly probeId: string;
}

/**
 * Reference command for the P1 guarantees (doc 07 §5.1): one transaction writes the domain row,
 * the audit event, the outbox event and the job. They commit together or not at all.
 */
export async function createProbe(
  deps: ProbeDeps,
  input: CreateProbeRequest,
  actorId: string,
): Promise<{ id: string }> {
  const id = uuidv7();
  await deps.db.transaction(async (tx) => {
    await tx.insert(probes).values({ id, label: input.label, createdAt: new Date() });
    await appendAudit(tx, {
      actorType: 'system',
      actorId,
      action: 'platform.probe.create',
      targetType: 'probe',
      targetId: id,
      summary: { labelLength: input.label.length },
      source: 'api',
    });
    const payload: ProbeCreatedPayload = { probeId: id, label: input.label };
    await appendOutbox(tx, { type: PROBE_CREATED_EVENT, aggregateType: 'probe', aggregateId: id, payload });
    await deps.jobs.send<ProbeJobData>(QUEUES.probeProcess.name, { probeId: id }, { tx });
    if (input.failAfterWrites) throw new DomainError('probe.forced_failure');
  });
  return { id };
}
