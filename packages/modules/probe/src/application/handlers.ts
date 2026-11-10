import { ProbeCreatedPayload } from '@qos/contracts';
import { and, eq, isNull, probes, type Db, type Tx } from '@qos/db';
import type { EventSubscriber } from '@qos/jobs';
import type { Job } from '@qos/ports';
import type { ProbeJobData } from './create-probe.js';

/**
 * Job handler. Idempotent through an expected-state update: only the first delivery changes the row,
 * a redelivery finds `processed_at` already set and does nothing.
 */
export async function processProbeJob(db: Db, job: Job<ProbeJobData>): Promise<{ changed: boolean }> {
  const updated = await db
    .update(probes)
    .set({ processedAt: new Date() })
    .where(and(eq(probes.id, job.data.probeId), isNull(probes.processedAt)))
    .returning({ id: probes.id });
  return { changed: updated.length === 1 };
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
