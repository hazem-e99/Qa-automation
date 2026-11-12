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

/**
 * On the Windows pilot machine, connecting to a port Docker has just published sometimes fails
 * with EACCES while many containers start at once. That is an environment hiccup, not a test
 * failure, so startup is retried a few times for that error only.
 */
const isTransientPortError = (e: unknown): boolean => {
  const err = e as { code?: string; message?: string; cause?: { code?: string } } | null;
  return (
    err?.code === 'EACCES' ||
    err?.cause?.code === 'EACCES' ||
    /connect EACCES|Failed to connect to Reaper/.test(String(err?.message))
  );
};

/** Starts a throwaway PostgreSQL (same image as production) and applies all migrations. */
export async function startTestDatabase(): Promise<TestDatabase> {
  for (let attempt = 1; ; attempt++) {
    let container: StartedPostgreSqlContainer | null = null;
    let pool: Pool | null = null;
    try {
      container = await new PostgreSqlContainer(PG_IMAGE).start();
      const url = container.getConnectionUri();
      const p = createPool({ connectionString: url, max: 5, applicationName: 'qos-test' });
      pool = p;
      await runMigrations(p);
      const started = container;
      return {
        container: started,
        url,
        pool: p,
        db: createDb(p),
        stop: async () => {
          await p.end();
          await started.stop();
        },
      };
    } catch (e) {
      await pool?.end().catch(() => undefined);
      await container?.stop().catch(() => undefined);
      if (attempt >= 3 || !isTransientPortError(e)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
