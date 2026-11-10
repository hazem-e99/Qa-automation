import { sql } from 'drizzle-orm';
import { index, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `platform` schema: cross-cutting tables (doc 10 §platform). This file is the drizzle-kit source.
 * Keep it free of relative imports so drizzle-kit can load it directly.
 */
export const platform = pgSchema('platform');

/** Outbox: written in the same transaction as the state change; the dispatcher delivers at least once. */
export const outboxEvents = platform.table(
  'outbox_events',
  {
    id: uuid('id').primaryKey(), // event_id (UUIDv7, application-generated)
    projectId: uuid('project_id'),
    type: text('type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    correlationId: text('correlation_id'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (t) => [
    index('outbox_undispatched_ix')
      .on(t.occurredAt)
      .where(sql`${t.dispatchedAt} is null`),
  ],
);

/**
 * Probe rows: the smallest possible "domain row", used by the platform probe command to prove
 * atomic commit/rollback and at-least-once processing. Not a product table.
 */
export const probes = platform.table('probes', {
  id: uuid('id').primaryKey(),
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  eventSeenAt: timestamp('event_seen_at', { withTimezone: true }),
});
