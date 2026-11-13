import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
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
    /** Demo projects may use demo (mock) connections; real projects never can (doc 11 §8). */
    isDemo: boolean('is_demo').notNull().default(false),
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

export const projectEnvironments = projectsSchema.table(
  'project_environments',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    baseUrls: text('base_urls').array().notNull(),
    /** Egress allow-list for test runs against this environment. */
    allowedHosts: text('allowed_hosts').array().notNull(),
    isProduction: boolean('is_production').notNull().default(false),
    /** SecretStore reference for test login data. The value is never stored here. */
    authSecretRef: text('auth_secret_ref'),
    authSecretUpdatedAt: timestamp('auth_secret_updated_at', { withTimezone: true }),
    resetHookUrl: text('reset_hook_url'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('project_environments_name_ux').on(t.projectId, t.name)],
);

/** Time-bounded assignment of a connection to a role in a project. History is never overwritten. */
export const projectBindings = projectsSchema.table(
  'project_bindings',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    connectionId: uuid('connection_id').notNull(),
    config: jsonb('config').notNull(),
    mode: text('mode').notNull(), // active | legacy_sync
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    startedBy: uuid('started_by').notNull(),
    endedBy: uuid('ended_by'),
  },
  (t) => [
    uniqueIndex('project_bindings_one_active_ux')
      .on(t.projectId, t.role)
      .where(sql`${t.endedAt} is null and ${t.role} not in ('requirements', 'notifications')`),
    index('project_bindings_connection_ix').on(t.connectionId),
    index('project_bindings_project_ix').on(t.projectId, t.startedAt),
  ],
);

export const projectSettings = projectsSchema.table(
  'project_settings',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    section: text('section').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    data: jsonb('data').notNull(),
    version: integer('version').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.section] })],
);

export const projectSettingsHistory = projectsSchema.table(
  'project_settings_history',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    section: text('section').notNull(),
    version: integer('version').notNull(),
    data: jsonb('data').notNull(),
    changedBy: uuid('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('project_settings_history_ix').on(t.projectId, t.section, t.changedAt)],
);

/**
 * Organization project templates (M02-FR-02): settings sections and environments (never secrets)
 * captured from a project. Built-in templates live in code, not here.
 */
export const projectTemplates = projectsSchema.table(
  'project_templates',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    data: jsonb('data').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('project_templates_org_name_ux').on(t.orgId, t.name)],
);
