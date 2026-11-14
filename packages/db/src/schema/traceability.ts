import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * `traceability` schema (doc 09 §5): one typed, versioned edge table shared by every module.
 * drizzle-kit source: keep it free of relative imports.
 */
export const traceabilitySchema = pgSchema('traceability');

/**
 * A link between two artifacts, e.g. a test case verifying a requirement. Endpoints are typed
 * ids (entity id plus, where it matters, the version id). Removal is a soft state so coverage at
 * a past time can be reconstructed. `needs_review` is set when the target changed under the link
 * (M04-FR-16): nothing downstream changes automatically.
 */
export const traceabilityLinks = traceabilitySchema.table(
  'traceability_links',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    type: text('type').notNull(),
    fromType: text('from_type').notNull(),
    fromId: uuid('from_id').notNull(),
    fromVersionId: uuid('from_version_id'),
    toType: text('to_type').notNull(),
    toId: uuid('to_id').notNull(),
    toVersionId: uuid('to_version_id'),
    acId: uuid('ac_id'),
    status: text('status').notNull().default('active'), // active | outdated | removed
    needsReview: boolean('needs_review').notNull().default(false),
    reviewReason: jsonb('review_reason'),
    origin: text('origin').notNull(), // user | ai | system
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('traceability_links_edge_ux')
      .on(t.projectId, t.type, t.fromType, t.fromId, t.toType, t.toId)
      .where(sql`${t.status} <> 'removed'`),
    index('traceability_links_to_ix').on(t.toType, t.toId, t.type, t.status),
    index('traceability_links_from_ix').on(t.fromType, t.fromId, t.type, t.status),
    index('traceability_links_project_ix').on(t.projectId, t.type, t.status),
    check('traceability_links_status_ck', sql`${t.status} in ('active', 'outdated', 'removed')`),
    check('traceability_links_origin_ck', sql`${t.origin} in ('user', 'ai', 'system')`),
  ],
);
