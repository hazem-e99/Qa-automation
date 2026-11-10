import { z } from 'zod';
import { Uuid } from './common.js';

/** Wire form of a domain event (doc 19 §1). Payloads are validated per event type by the owning module. */
export const EventEnvelope = z.object({
  eventId: Uuid,
  type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  projectId: Uuid.nullable(),
  occurredAt: z.iso.datetime(),
  correlationId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
