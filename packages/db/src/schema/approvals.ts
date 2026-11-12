import { sql } from 'drizzle-orm';
import {
  boolean,
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
 * Approvals and notifications (doc 10 §governance, M14). They live in the `governance` schema
 * next to the audit log; the schema itself is created by migration 0001.
 * drizzle-kit source: keep it free of relative imports.
 */
const governanceTables = pgSchema('governance');

export const approvalPolicies = governanceTables.table(
  'approval_policies',
  {
    projectId: uuid('project_id').notNull(),
    action: text('action').notNull(),
    rules: jsonb('rules').notNull(),
    version: integer('version').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.action] })],
);

export const approvalRequests = governanceTables.table(
  'approval_requests',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    /** The approval applies to exactly this content (BR-M14-3). */
    contentHash: text('content_hash').notNull(),
    policyVersion: integer('policy_version').notNull(),
    /** Rules as they were when the request was made: later policy edits do not apply (M14 §14). */
    rules: jsonb('rules').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    status: text('status').notNull(), // pending | approved | rejected | invalidated | expired
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('approval_requests_project_ix').on(t.projectId, t.status),
    // One pending request per target and action.
    uniqueIndex('approval_requests_one_pending_ux')
      .on(t.projectId, t.action, t.targetType, t.targetId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const approvalDecisions = governanceTables.table(
  'approval_decisions',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    approverId: uuid('approver_id').notNull(),
    decision: text('decision').notNull(), // approve | reject
    comment: text('comment'),
    /** Set when the author approved their own request under the single-approver override. */
    selfApproval: boolean('self_approval').notNull().default(false),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.approverId] })],
);

export const notifications = governanceTables.table(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    projectId: uuid('project_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('notifications_user_dedupe_ux').on(t.userId, t.dedupeKey),
    index('notifications_user_ix').on(t.userId, t.createdAt),
  ],
);

export const notificationPreferences = governanceTables.table(
  'notification_preferences',
  {
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    inApp: boolean('in_app').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type] })],
);
