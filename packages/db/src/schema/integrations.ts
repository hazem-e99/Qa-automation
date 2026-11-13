import {
  boolean,
  integer,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** `integrations` schema (doc 10 §integrations). drizzle-kit source: keep it free of relative imports. */
export const integrationsSchema = pgSchema('integrations');

export const connections = integrationsSchema.table(
  'connections',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    providerType: text('provider_type').notNull(),
    family: text('family').notNull(),
    displayName: text('display_name').notNull(),
    baseUrl: text('base_url'),
    externalInstance: text('external_instance'),
    authStrategy: text('auth_strategy').notNull(),
    /** Reference into the SecretStore. The credential itself is never stored here. */
    secretRef: text('secret_ref'),
    status: text('status').notNull(), // untested | active | degraded | auth_failed | retired
    isDemo: boolean('is_demo').notNull().default(false),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    credentialExpiresAt: timestamp('credential_expires_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('connections_org_type_ix').on(t.orgId, t.providerType),
    uniqueIndex('connections_org_name_ux').on(t.orgId, t.displayName),
  ],
);

export const connectionChecks = integrationsSchema.table(
  'connection_checks',
  {
    id: uuid('id').primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    ok: boolean('ok').notNull(),
    /** Sanitized result: identity, scopes, per-capability checks, or a normalized error kind. */
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('connection_checks_conn_ix').on(t.connectionId, t.createdAt)],
);

export const connectionCapabilities = integrationsSchema.table(
  'connection_capabilities',
  {
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    ok: boolean('ok').notNull(),
    detail: text('detail'),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.capability] })],
);

export const externalRefs = integrationsSchema.table(
  'external_refs',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id'),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id),
    providerType: text('provider_type').notNull(),
    externalInstance: text('external_instance'),
    externalType: text('external_type').notNull(),
    externalId: text('external_id').notNull(),
    externalUrl: text('external_url'),
    externalVersion: text('external_version'),
    snapshot: jsonb('snapshot').notNull(),
    status: text('status').notNull(), // live | deleted_externally | source_retired
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('external_refs_conn_type_id_ux').on(t.connectionId, t.externalType, t.externalId),
    index('external_refs_project_type_ix').on(t.projectId, t.externalType),
  ],
);

/** One inbound webhook endpoint per connection. Path token and signing secret are never stored in clear. */
export const webhookEndpoints = integrationsSchema.table(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    /** SHA-256 of the random token in the endpoint URL. */
    pathSecretHash: text('path_secret_hash').notNull(),
    verification: text('verification').notNull(),
    /** SecretStore reference of the signing secret (HMAC key, shared token or basic-auth password). */
    secretRef: text('secret_ref').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('webhook_endpoints_connection_ux').on(t.connectionId)],
);

/** Where each sync stream of a binding stopped. Written in the same transaction as the page it covers. */
export const syncCursors = integrationsSchema.table(
  'sync_cursors',
  {
    bindingId: uuid('binding_id').notNull(),
    stream: text('stream').notNull(),
    cursor: text('cursor'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.bindingId, t.stream] })],
);

export const syncRuns = integrationsSchema.table(
  'sync_runs',
  {
    id: uuid('id').primaryKey(),
    bindingId: uuid('binding_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    stream: text('stream').notNull(),
    mode: text('mode').notNull(), // incremental | full
    status: text('status').notNull(), // running | succeeded | partial | failed | deferred
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    pages: integer('pages').notNull().default(0),
    itemsSeen: integer('items_seen').notNull().default(0),
    itemsChanged: integer('items_changed').notNull().default(0),
    /** Normalized provider error kind, never a raw message. */
    errorKind: text('error_kind'),
    retryAfterMs: integer('retry_after_ms'),
  },
  (t) => [
    index('sync_runs_binding_ix').on(t.bindingId, t.startedAt),
    index('sync_runs_connection_ix').on(t.connectionId, t.startedAt),
    // At most one running sync per binding and stream, whatever the queue does.
    uniqueIndex('sync_runs_one_running_ux')
      .on(t.bindingId, t.stream)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const syncErrors = integrationsSchema.table(
  'sync_errors',
  {
    id: uuid('id').primaryKey(),
    syncRunId: uuid('sync_run_id')
      .notNull()
      .references(() => syncRuns.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    kind: text('kind').notNull(),
    /** Sanitized: an error kind and a short fixed text, never provider payloads or credentials. */
    message: text('message').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    status: text('status').notNull(), // open | resolved
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sync_errors_run_ix').on(t.syncRunId)],
);

/**
 * Value mappings of a tracker binding (M03-FR-07, doc 10 `status_mappings`/`field_mappings`/
 * `type_mappings` folded into one versioned row per binding and kind). `discovered` holds the
 * external values the provider reported at the last discovery, which the lint checks against.
 */
export const valueMappings = integrationsSchema.table(
  'value_mappings',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    bindingId: uuid('binding_id').notNull(),
    kind: text('kind').notNull(), // status | severity | priority | type
    entries: jsonb('entries').notNull(), // [{ external, canonical }]
    discovered: jsonb('discovered'), // string[] | null
    discoveredAt: timestamp('discovered_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('value_mappings_binding_kind_ux').on(t.bindingId, t.kind),
    index('value_mappings_project_ix').on(t.projectId),
  ],
);
