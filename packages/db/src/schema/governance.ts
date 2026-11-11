import { inet, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `governance.audit_events` is range-partitioned by month and append-only (doc 10).
 * drizzle-kit cannot express partitioning, so its DDL lives in a hand-written migration
 * (`migrations/0001_*.sql`) and this definition is used for typed queries only.
 * It is intentionally NOT listed in drizzle.config.ts.
 */
export const governance = pgSchema('governance');

export const auditEvents = governance.table(
  'audit_events',
  {
    id: uuid('id').notNull(),
    orgId: uuid('org_id'),
    projectId: uuid('project_id'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    summary: jsonb('summary').notNull(),
    source: text('source').notNull(),
    ip: inet('ip'),
    ua: text('ua'),
    correlationId: text('correlation_id'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.id, t.createdAt] })],
);

/** Envelope-encrypted secrets (doc 21 §6). DDL lives in a hand-written migration, like audit_events. */
export const secrets = governance.table('secrets', {
  ref: uuid('ref').primaryKey(),
  ownerType: text('owner_type').notNull(),
  ownerId: text('owner_id').notNull(),
  purpose: text('purpose').notNull(),
  ciphertext: text('ciphertext').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  keyId: text('key_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});
