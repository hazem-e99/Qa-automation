import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Db = NodePgDatabase;
/** Transaction handle. Repositories and the job queue accept this to join the caller's transaction. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;
export type Pool = pg.Pool;

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly applicationName?: string;
}

export function createPool(opts: PoolOptions): Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'qualityos',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export const createDb = (pool: Pool): Db => drizzle(pool);

export async function pingDb(pool: Pool): Promise<void> {
  await pool.query('select 1');
}
