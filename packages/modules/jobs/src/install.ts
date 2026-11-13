import pg from 'pg';
import type { Logger } from '@qos/observability';
import { PgBossJobQueue } from './pgboss-job-queue.js';
import { ALL_QUEUES } from './queues.js';

/**
 * Installs (or upgrades) the job schema and creates every known queue, using the owner's
 * connection, then grants the services' role DML on it (T-P2-50). pg-boss creates a table per
 * queue, which is DDL; doing it here means the services themselves never need DDL privileges.
 * Run by the migrate step before api and worker start. Idempotent.
 */
export async function installJobSchema(opts: { connectionString: string; logger: Logger }): Promise<void> {
  const queue = new PgBossJobQueue({
    connectionString: opts.connectionString,
    queues: ALL_QUEUES,
    logger: opts.logger,
    supervise: false,
    applicationName: 'qos-migrate-jobs',
  });
  await queue.start();
  await queue.stop();
  const client = new pg.Client({
    connectionString: opts.connectionString,
    application_name: 'qos-migrate-jobs',
  });
  await client.connect();
  try {
    await client.query(`
      do $$
      begin
        if exists (select 1 from pg_roles where rolname = 'qos_app') then
          grant usage on schema pgboss to qos_app;
          grant select, insert, update, delete on all tables in schema pgboss to qos_app;
          grant usage, select, update on all sequences in schema pgboss to qos_app;
          grant execute on all functions in schema pgboss to qos_app;
        end if;
      end
      $$`);
  } finally {
    await client.end();
  }
}
