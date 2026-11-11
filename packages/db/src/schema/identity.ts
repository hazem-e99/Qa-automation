import {
  boolean,
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
