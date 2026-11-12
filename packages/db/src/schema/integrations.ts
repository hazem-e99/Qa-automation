import {
  boolean,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
