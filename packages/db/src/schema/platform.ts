import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
  operationId: uuid('operation_id'),
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  eventSeenAt: timestamp('event_seen_at', { withTimezone: true }),
});

/**
 * Idempotency records for API mutations (doc 22 §4). The row is written in the same transaction
 * as the effect, so a stored response always corresponds to a committed effect.
 */
export const idempotencyKeys = platform.table(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull(), // in_progress | done
    responseStatus: integer('response_status'),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] }), index('idempotency_expires_ix').on(t.expiresAt)],
);

/** Long-running operations that clients follow by polling or SSE (FR-X-07). */
export const operations = platform.table(
  'operations',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id'),
    type: text('type').notNull(),
    status: text('status').notNull(), // queued | running | succeeded | failed | cancelled
    progress: integer('progress').notNull().default(0),
    resultRef: text('result_ref'),
    error: text('error'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('operations_project_ix').on(t.projectId, t.createdAt)],
);

/**
 * Inbound webhook deliveries (doc 10). The unique key makes a redelivered webhook a no-op.
 * `connection_id` gets its foreign key when the connections table arrives in P2.
 */
export const inboxMessages = platform.table(
  'inbox_messages',
  {
    id: uuid('id').primaryKey(),
    connectionId: uuid('connection_id').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    verification: text('verification').notNull(), // ok | rejected | unsigned_accepted
    headers: jsonb('headers').notNull(), // allow-listed headers only
    bodyRef: text('body_ref'),
    status: text('status').notNull(), // pending | processed | duplicate | stale | ignored_out_of_scope | failed
    attempts: integer('attempts').notNull().default(0),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('inbox_connection_dedupe_ux').on(t.connectionId, t.dedupeKey),
    index('inbox_pending_ix')
      .on(t.receivedAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);
