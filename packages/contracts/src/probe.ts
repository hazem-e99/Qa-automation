import { z } from 'zod';
import { Uuid } from './common.js';

/**
 * Platform probe: a deliberately tiny command used to prove the P1 transaction guarantees
 * (domain row + audit + outbox + job commit or roll back together). Not a product feature.
 */
export const CreateProbeRequest = z.object({
  label: z.string().trim().min(1).max(200),
  /** Test hook: fail after all writes so the rollback can be observed. Rejected in production. */
  failAfterWrites: z.boolean().optional(),
});
export type CreateProbeRequest = z.infer<typeof CreateProbeRequest>;

export const ProbeResponse = z.object({
  id: Uuid,
  label: z.string(),
  processedAt: z.iso.datetime().nullable(),
  /** Follow progress at /api/v1/operations/{operationId} (JSON) or …/events (SSE). */
  operationId: Uuid.nullable(),
});
export type ProbeResponse = z.infer<typeof ProbeResponse>;

export const PROBE_CREATED_EVENT = 'platform.probe.created';
export const ProbeCreatedPayload = z.object({ probeId: Uuid, label: z.string() });
export type ProbeCreatedPayload = z.infer<typeof ProbeCreatedPayload>;
