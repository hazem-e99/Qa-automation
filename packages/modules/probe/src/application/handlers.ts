import { ProbeCreatedPayload } from '@qos/contracts';
import { and, eq, isNull, probes, type Db, type Tx } from '@qos/db';
import type { EventSubscriber } from '@qos/jobs';
import { transitionOperation } from '@qos/platform';
import type { Job } from '@qos/ports';
import type { ProbeJobData } from './create-probe.js';

/**
 * Job handler. Idempotent through expected-state updates: only the first delivery changes the row
 * and the operation; a redelivery finds them already moved and does nothing.
 */
export async function processProbeJob(db: Db, job: Job<ProbeJobData>): Promise<{ changed: boolean }> {
  const [probe] = await db.select().from(probes).where(eq(probes.id, job.data.probeId));
  if (!probe) return { changed: false };
  if (probe.operationId) {
    await transitionOperation(db, probe.operationId, ['queued'], { status: 'running', progress: 50 });
  }
  const changed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(probes)
      .set({ processedAt: new Date() })
      .where(and(eq(probes.id, probe.id), isNull(probes.processedAt)))
      .returning({ id: probes.id });
    if (probe.operationId) {
      await transitionOperation(tx, probe.operationId, ['queued', 'running'], {
        status: 'succeeded',
        progress: 100,
        resultRef: `probe:${probe.id}`,
      });
    }
    return updated.length === 1;
  });
  return { changed };
}

/** Outbox subscriber for `platform.probe.created`. Same idempotency rule as the job handler. */
export const onProbeCreated: EventSubscriber = async (event, tx: Tx) => {
  const payload = ProbeCreatedPayload.parse(event.payload);
  await tx
    .update(probes)
    .set({ eventSeenAt: new Date() })
    .where(and(eq(probes.id, payload.probeId), isNull(probes.eventSeenAt)));
};

export async function getProbe(db: Db, id: string) {
  const [row] = await db.select().from(probes).where(eq(probes.id, id));
  return row ?? null;
}
