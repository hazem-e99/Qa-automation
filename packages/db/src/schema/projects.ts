import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** `projects` schema (doc 10 §projects). drizzle-kit source: keep it free of relative imports. */
export const projectsSchema = pgSchema('projects');

export const projects = projectsSchema.table(
  'projects',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status').notNull(), // draft | active | archived | deleted
    templateId: uuid('template_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('projects_org_key_ux').on(t.orgId, t.key),
    check('projects_key_format', sql`${t.key} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
    check('projects_status_valid', sql`${t.status} in ('draft', 'active', 'archived', 'deleted')`),
  ],
);

/** Per-project counters behind human-readable ids such as PAY-REQ-12. */
export const projectKeySequences = projectsSchema.table(
  'project_key_sequences',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    nextValue: integer('next_value').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.entityType] })],
);
