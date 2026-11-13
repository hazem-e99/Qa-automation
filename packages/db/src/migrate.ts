import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from './client.js';

/** `migrations/` sits next to `dist/` and `src/` in the package. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

const MIGRATION_LOCK_KEY = 4_815_162_342; // arbitrary constant; one migrator at a time

/**
 * Applies pending migrations, then makes sure the audit partitions for the current and next
 * month exist. Safe to run from several processes at once: a session advisory lock serializes them.
 */
export async function runMigrations(pool: Pool, now: Date = new Date()): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
      for (const offset of [0, 1]) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
        await client.query('select governance.ensure_audit_partition($1::date)', [
          d.toISOString().slice(0, 10),
        ]);
      }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/**
 * Creates or updates the login role the services connect with, as a member of `qos_app`
 * (doc 10 §2). Run by the migrate step with the owner's connection; the password comes from
 * configuration and is applied on every run, so rotating it is just a restart of `migrate`.
 */
export async function provisionAppLogin(
  pool: Pool,
  login: { user: string; password: string },
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{2,62}$/.test(login.user)) throw new Error('invalid app database user name');
  if (login.password.length < 16) throw new Error('app database password must have at least 16 characters');
  const client = await pool.connect();
  try {
    const user = client.escapeIdentifier(login.user);
    const password = client.escapeLiteral(login.password);
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [login.user]);
    await client.query(
      exists.rowCount
        ? `alter role ${user} with login nosuperuser nocreatedb nocreaterole noreplication password ${password}`
        : `create role ${user} with login nosuperuser nocreatedb nocreaterole noreplication password ${password}`,
    );
    await client.query(`grant qos_app to ${user}`);
  } finally {
    client.release();
  }
}
