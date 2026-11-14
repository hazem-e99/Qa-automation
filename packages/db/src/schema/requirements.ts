import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * `requirements` schema (doc 10 §requirements, M04). drizzle-kit source: keep it free of
 * relative imports. Embeddings (pgvector) arrive with P5.
 */
export const requirementsSchema = pgSchema('requirements');

/** A place requirements come from (M04-FR-01). `external`: a requirements-family connection through its binding (e.g. a work-item tracker), whatever the provider. */
export const requirementSources = requirementsSchema.table(
  'requirement_sources',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    bindingId: uuid('binding_id'),
    config: jsonb('config').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('requirement_sources_project_name_ux').on(t.projectId, t.name),
    check(
      'requirement_sources_kind_ck',
      sql`${t.kind} in ('external', 'document_set', 'spreadsheet', 'manual')`,
    ),
  ],
);

/** A logical document of a document or spreadsheet source; its uploads are versions (series). */
export const sourceDocuments = requirementsSchema.table(
  'source_documents',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => requirementSources.id),
    title: text('title').notNull(),
    languageHint: text('language_hint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('source_documents_source_ix').on(t.sourceId)],
);

/**
 * One captured state of a source: a document version, a work item revision, or a manual entry.
 * The same content captured twice is one snapshot (unique checksum per source).
 */
export const sourceSnapshots = requirementsSchema.table(
  'source_snapshots',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => requirementSources.id),
    documentId: uuid('document_id').references(() => sourceDocuments.id),
    externalRefId: uuid('external_ref_id'),
    externalVersion: text('external_version'),
    checksum: text('checksum').notNull(),
    storedObjectKey: text('stored_object_key'),
    capturedBy: uuid('captured_by'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    parseStatus: text('parse_status').notNull(), // not_needed | pending | parsed | failed | rejected
    extractionQuality: jsonb('extraction_quality'),
  },
  (t) => [
    uniqueIndex('source_snapshots_source_checksum_ux').on(t.sourceId, t.checksum),
    index('source_snapshots_project_ix').on(t.projectId, t.capturedAt),
  ],
);

/** A candidate found in a snapshot, with where it was found (locator) and how sure we are. */
export const extractedItems = requirementsSchema.table(
  'extracted_items',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => sourceSnapshots.id),
    kind: text('kind').notNull(), // requirement | ac | context | unsupported_visual
    text: text('text').notNull(),
    locator: jsonb('locator').notNull().default({}),
    language: text('language'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    method: text('method').notNull(), // structural | ai | manual
    status: text('status').notNull(), // candidate | accepted | merged | rejected
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('extracted_items_snapshot_ix').on(t.snapshotId),
    index('extracted_items_project_status_ix').on(t.projectId, t.status),
  ],
);

/** The canonical requirement (stable key PRJ-R-n). Its content lives in immutable versions. */
export const requirements = requirementsSchema.table(
  'requirements',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    key: text('key').notNull(),
    effectiveVersionId: uuid('effective_version_id'),
    latestVersionId: uuid('latest_version_id'),
    sourceRemoved: boolean('source_removed').notNull().default(false),
    divergedFromSource: boolean('diverged_from_source').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('requirements_project_key_ux').on(t.projectId, t.key)],
);

/**
 * Immutable content of one requirement version (BR-M04-2). Only the workflow columns (state,
 * timestamps, approval request) may change; a trigger refuses any content update.
 * `search_text` is the Arabic-normalized title + body + AC, for search (M04-FR-19).
 */
export const requirementVersions = requirementsSchema.table(
  'requirement_versions',
  {
    id: uuid('id').primaryKey(),
    requirementId: uuid('requirement_id')
      .notNull()
      .references(() => requirements.id),
    projectId: uuid('project_id').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    priority: text('priority'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    origin: text('origin').notNull(), // source | manual | inferred | mixed
    state: text('state').notNull(), // draft | in_review | approved | superseded | obsolete | rejected
    contentHash: text('content_hash').notNull(),
    searchText: text('search_text').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvalRequestId: uuid('approval_request_id'),
  },
  (t) => [
    uniqueIndex('requirement_versions_number_ux').on(t.requirementId, t.number),
    index('requirement_versions_project_state_ix').on(t.projectId, t.state),
    index('requirement_versions_search_trgm_ix').using('gin', sql`${t.searchText} gin_trgm_ops`),
  ],
);

export const acceptanceCriteria = requirementsSchema.table(
  'acceptance_criteria',
  {
    id: uuid('id').primaryKey(),
    requirementVersionId: uuid('requirement_version_id')
      .notNull()
      .references(() => requirementVersions.id),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    origin: text('origin').notNull(), // source | inferred
    extractedItemId: uuid('extracted_item_id'),
  },
  (t) => [uniqueIndex('acceptance_criteria_version_ordinal_ux').on(t.requirementVersionId, t.ordinal)],
);

/** Where a version's content came from (BR-M04-3: at least one per version). */
export const requirementProvenance = requirementsSchema.table(
  'requirement_provenance',
  {
    requirementVersionId: uuid('requirement_version_id')
      .notNull()
      .references(() => requirementVersions.id),
    extractedItemId: uuid('extracted_item_id')
      .notNull()
      .references(() => extractedItems.id),
  },
  (t) => [primaryKey({ columns: [t.requirementVersionId, t.extractedItemId] })],
);

/** Conflicts, gaps, ambiguities (M04-FR-13/14). Open conflicts block approval (BR-M04-6). */
export const requirementFindings = requirementsSchema.table(
  'requirement_findings',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    type: text('type').notNull(), // conflict | gap | ambiguity | duplicate
    status: text('status').notNull(), // open | resolved | waived | dismissed
    subjectIds: uuid('subject_ids').array().notNull(),
    detail: jsonb('detail').notNull().default({}),
    resolution: jsonb('resolution'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('requirement_findings_project_ix').on(t.projectId, t.type, t.status)],
);
