import { PROBE_CREATED_EVENT, type CreateProbeRequest, type ProbeCreatedPayload } from '@qos/contracts';
import { appendAudit, probes, type Db, type Tx } from '@qos/db';
import { appendOutbox, QUEUES } from '@qos/jobs';
import { DomainError, uuidv7 } from '@qos/kernel-domain';
import { createOperation } from '@qos/platform';
import type { JobQueue } from '@qos/ports';

export interface ProbeDeps {
  readonly db: Db;
  readonly jobs: JobQueue<Tx>;
}

export interface ProbeJobData {
  readonly probeId: string;
}

export const PROBE_OPERATION_TYPE = 'platform.probe';

/**
 * Reference command for the P1 guarantees (doc 07 §5.1): one transaction writes the domain row,
 * the operation, the audit event, the outbox event and the job. They commit together or not at all.
 * Pass `tx` to join a transaction the caller already owns (for example the idempotency wrapper).
 */
export async function createProbe(
  deps: ProbeDeps,
  input: CreateProbeRequest,
  actorId: string,
  tx?: Tx,
): Promise<{ id: string; operationId: string }> {
  const id = uuidv7();
  const write = async (t: Tx): Promise<string> => {
    const operationId = await createOperation(t, { type: PROBE_OPERATION_TYPE, createdBy: actorId });
    await t.insert(probes).values({ id, operationId, label: input.label, createdAt: new Date() });
    await appendAudit(t, {
      actorType: 'system',
      actorId,
      action: 'platform.probe.create',
      targetType: 'probe',
      targetId: id,
      summary: { labelLength: input.label.length },
      source: 'api',
    });
    const payload: ProbeCreatedPayload = { probeId: id, label: input.label };
    await appendOutbox(t, { type: PROBE_CREATED_EVENT, aggregateType: 'probe', aggregateId: id, payload });
    await deps.jobs.send<ProbeJobData>(QUEUES.probeProcess.name, { probeId: id }, { tx: t });
    if (input.failAfterWrites) throw new DomainError('probe.forced_failure');
    return operationId;
  };
  const operationId = tx ? await write(tx) : await deps.db.transaction(write);
  return { id, operationId };
}
