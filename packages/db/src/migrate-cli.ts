import { createPool } from './client.js';
import { runMigrations } from './migrate.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}
const pool = createPool({ connectionString, max: 2, applicationName: 'qos-migrate' });
try {
  await runMigrations(pool);
  console.log('migrations applied');
} catch (e) {
  console.error('migration failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
