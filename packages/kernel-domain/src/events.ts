/** Envelope of a domain event as stored in the outbox (doc 10, `outbox_events`). */
export interface DomainEvent<TPayload = unknown> {
  readonly eventId: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly projectId: string | null;
  readonly occurredAt: Date;
  readonly correlationId: string | null;
  readonly payload: TPayload;
}

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
