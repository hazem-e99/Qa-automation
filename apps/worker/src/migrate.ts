import { createPool, provisionAppLogin, runMigrations } from '@qos/db';
import { installJobSchema } from '@qos/jobs';
import { createLogger } from '@qos/observability';

/**
 * The migrate step of the stack (doc 10 §2, T-P2-50), run with the database owner's connection:
 *  1. schema migrations and audit partitions,
 *  2. the job schema and every queue (pg-boss DDL happens here, not in the services),
 *  3. the services' login role as a member of `qos_app`, when QOS_APP_DB_USER/PASSWORD are set.
 * api and worker then connect with that login role: DML only, append-only audit log.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(2);
}
const logger = createLogger({ service: 'migrate', level: 'info' });
const pool = createPool({ connectionString, max: 2, applicationName: 'qos-migrate' });
try {
  await runMigrations(pool);
  await installJobSchema({ connectionString, logger });
  const user = process.env.QOS_APP_DB_USER;
  const password = process.env.QOS_APP_DB_PASSWORD;
  if (user && password) {
    await provisionAppLogin(pool, { user, password });
    logger.info({ user }, 'service login role ready');
  } else {
    logger.warn('QOS_APP_DB_USER/QOS_APP_DB_PASSWORD not set: services must use the owner connection');
  }
  logger.info('migrations applied');
} catch (e) {
  logger.error({ err: e }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
