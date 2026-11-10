import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, createPool, runMigrations, type Db, type Pool } from './index.js';

export const PG_IMAGE = 'pgvector/pgvector:0.8.7-pg17';

export interface TestDatabase {
  readonly container: StartedPostgreSqlContainer;
  readonly url: string;
  readonly pool: Pool;
  readonly db: Db;
  stop(): Promise<void>;
}

/** Starts a throwaway PostgreSQL (same image as production) and applies all migrations. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(PG_IMAGE).start();
  const url = container.getConnectionUri();
  const pool = createPool({ connectionString: url, max: 5, applicationName: 'qos-test' });
  await runMigrations(pool);
  return {
    container,
    url,
    pool,
    db: createDb(pool),
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
