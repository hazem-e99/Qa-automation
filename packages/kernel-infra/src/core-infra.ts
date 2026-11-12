import { createDb, createPool, pingDb, type Db, type Pool } from '@qos/db';
import { ALL_QUEUES, PgBossJobQueue } from '@qos/jobs';
import { createLogger, type Logger } from '@qos/observability';
import type { BaseConfig } from './config.js';

export interface CoreInfra {
  readonly logger: Logger;
  readonly pool: Pool;
  readonly db: Db;
  readonly jobs: PgBossJobQueue;
  readonly checks: { db: () => Promise<void>; jobs: () => Promise<void> };
  close(): Promise<void>;
}

export interface CoreInfraOptions {
  readonly service: string;
  /** True only for the worker: it owns queue maintenance. */
  readonly superviseJobs: boolean;
  readonly jobPollingIntervalSeconds?: number;
  /** Where log lines go. Defaults to stdout; tests pass a capture stream for log scans. */
  readonly logDestination?: { write(line: string): void };
}

/** Builds the shared infrastructure of a backend process: logger, database pool and job queue. */
export async function createCoreInfra(config: BaseConfig, opts: CoreInfraOptions): Promise<CoreInfra> {
  const logger = createLogger({
    service: opts.service,
    level: config.LOG_LEVEL,
    ...(opts.logDestination ? { destination: opts.logDestination } : {}),
  });
  const pool = createPool({ connectionString: config.DATABASE_URL, applicationName: `qos-${opts.service}` });
  pool.on('error', (err) => logger.error({ err }, 'database pool error'));
  const jobs = new PgBossJobQueue({
    connectionString: config.DATABASE_URL,
    queues: ALL_QUEUES,
    logger,
    supervise: opts.superviseJobs,
    applicationName: `qos-${opts.service}-jobs`,
    ...(opts.jobPollingIntervalSeconds ? { pollingIntervalSeconds: opts.jobPollingIntervalSeconds } : {}),
  });
  let jobsStarted = false;
  try {
    await pingDb(pool);
    await jobs.start();
    jobsStarted = true;
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
  return {
    logger,
    pool,
    db: createDb(pool),
    jobs,
    checks: {
      db: () => pingDb(pool),
      jobs: async () => {
        if (!jobsStarted) throw new Error('job queue not started');
      },
    },
    close: async () => {
      jobsStarted = false;
      await jobs.stop().catch((err) => logger.warn({ err }, 'job queue stop failed'));
      await pool.end().catch((err) => logger.warn({ err }, 'pool end failed'));
    },
  };
}
