import {
  bigint,
  boolean,
  integer,
  customType,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * `identity` schema (doc 10 §identity). drizzle-kit source: keep it free of relative imports.
 * Project foreign keys are added when the projects table arrives.
 */
export const identity = pgSchema('identity');

/** Case-insensitive text (citext extension, created in migration 0001). */
const citext = customType<{ data: string }>({ dataType: () => 'citext' });

export const organizations = identity.table(
  'organizations',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    settings: jsonb('settings').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('organizations_slug_ux').on(t.slug)],
);

export const users = identity.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    email: citext('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash'),
    mfaSecretRef: text('mfa_secret_ref'),
    /** Set once the user confirmed a TOTP code; MFA is required at login from then on. */
    mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
    /** Last accepted TOTP time step: a code is never accepted twice (replay). */
    mfaLastStep: bigint('mfa_last_step', { mode: 'number' }),
    locale: text('locale').notNull().default('en'),
    timezone: text('timezone').notNull().default('UTC'),
    status: text('status').notNull(), // invited | active | deactivated
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('users_org_email_ux').on(t.orgId, t.email)],
);

/** The primary key is the SHA-256 of the opaque session token; the token itself is never stored. */
export const sessions = identity.table(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    ua: text('ua'),
  },
  (t) => [index('sessions_user_ix').on(t.userId), index('sessions_expires_ix').on(t.expiresAt)],
);

export const roles = identity.table(
  'roles',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    scope: text('scope').notNull(), // platform | org | project
    isBuiltin: boolean('is_builtin').notNull().default(true),
  },
  (t) => [uniqueIndex('roles_key_ux').on(t.key)],
);

export const permissions = identity.table('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
});

export const rolePermissions = identity.table(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
    /** granted | own | policy (doc M13 §9: ●, ● (own), ◐). */
    grant: text('grant').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const orgMemberships = identity.table(
  'org_memberships',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId, t.roleId] }),
    index('org_memberships_user_ix').on(t.userId),
  ],
);

export const projectMemberships = identity.table(
  'project_memberships',
  {
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    flags: jsonb('flags').notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_memberships_user_ix').on(t.userId),
  ],
);

/** One-time recovery codes for MFA, stored as SHA-256 hashes. */
export const mfaRecoveryCodes = identity.table(
  'mfa_recovery_codes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.codeHash] })],
);

/**
 * Second step of a login with MFA. The primary key is the SHA-256 of the challenge token handed
 * to the client after a correct password; a challenge allows a few attempts and lives 5 minutes.
 */
export const mfaChallenges = identity.table(
  'mfa_challenges',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('mfa_challenges_user_ix').on(t.userId)],
);

/** Invitations (M13-FR-01): the token is shown once; only its hash is stored. */
export const invitations = identity.table(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /** The invited account (status `invited` until accepted). */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    orgRole: text('org_role'),
    projectId: uuid('project_id'),
    projectRole: text('project_role'),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('invitations_token_ux').on(t.tokenHash), index('invitations_user_ix').on(t.userId)],
);

/** Admin-generated password reset links (M13 §13). Only the token hash is stored. */
export const passwordResets = identity.table(
  'password_resets',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdBy: uuid('created_by').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('password_resets_token_ux').on(t.tokenHash)],
);

export const serviceAccounts = identity.table(
  'service_accounts',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull(), // active | disabled
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('service_accounts_org_name_ux').on(t.orgId, t.name)],
);

/**
 * API tokens (M13-FR-04). The token is shown once. `prefix` identifies it; `token_hash` is an
 * HMAC-SHA256 of the whole token with a pepper kept in the secret store.
 */
export const apiTokens = identity.table(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    ownerType: text('owner_type').notNull(), // service_account
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    /** Null: every project of the organization. */
    projectIds: uuid('project_ids').array(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('api_tokens_prefix_ux').on(t.prefix),
    index('api_tokens_owner_ix').on(t.ownerType, t.ownerId),
  ],
);
