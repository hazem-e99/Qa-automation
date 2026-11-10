import { PgBoss, fromDrizzle } from 'pg-boss';
import { sql, type Tx } from '@qos/db';
import { currentCorrelationId, runWithCorrelation, type Logger } from '@qos/observability';
import type { JobHandler, JobQueue, QueueDefinition, SendOptions } from '@qos/ports';

/** What is stored as the pg-boss job payload: the data plus the correlation id of the sender. */
interface Envelope<T> {
  readonly data: T;
  readonly correlationId: string | null;
}

export interface PgBossJobQueueOptions {
  readonly connectionString: string;
  readonly queues: readonly QueueDefinition[];
  readonly logger: Logger;
  /** Only the worker supervises (maintenance, scheduling). API processes just send. */
  readonly supervise: boolean;
  readonly applicationName?: string;
  /** Idle poll interval of workers (>= 0.5). Default 1 s. */
  readonly pollingIntervalSeconds?: number;
}

/** JobQueue adapter on pg-boss (ADR-0006). At-least-once delivery: handlers must be idempotent. */
export class PgBossJobQueue implements JobQueue<Tx> {
  private readonly boss: PgBoss;
  private readonly known: ReadonlySet<string>;
  private started = false;

  constructor(private readonly opts: PgBossJobQueueOptions) {
    this.boss = new PgBoss({
      connectionString: opts.connectionString,
      application_name: opts.applicationName ?? 'qos-jobs',
      max: 5,
      supervise: opts.supervise,
      schedule: opts.supervise,
      migrate: true,
    });
    this.known = new Set(opts.queues.map((q) => q.name));
    this.boss.on('error', (err: unknown) => opts.logger.error({ err }, 'job queue error'));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    // Dead-letter targets must exist before the queues that point at them.
    const ordered = [...this.opts.queues].sort((a, b) => Number(!!a.deadLetter) - Number(!!b.deadLetter));
    for (const q of ordered) {
      const options = {
        policy: q.policy,
        retryLimit: q.retryLimit,
        retryDelay: q.retryDelaySeconds,
        retryBackoff: q.retryBackoff,
        expireInSeconds: q.expireInSeconds,
        ...(q.deadLetter ? { deadLetter: q.deadLetter } : {}),
      };
      const existing = await this.boss.getQueue(q.name);
      if (existing) {
        const { policy: _policy, ...updatable } = options;
        await this.boss.updateQueue(q.name, updatable);
      } else {
        await this.boss.createQueue(q.name, options);
      }
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.boss.stop({ graceful: true, timeout: 15_000 });
  }

  async send<T extends object>(
    queue: string,
    data: T,
    options: SendOptions<Tx> = {},
  ): Promise<string | null> {
    this.assertKnown(queue);
    const envelope: Envelope<T> = { data, correlationId: currentCorrelationId() };
    return this.boss.send(queue, envelope, {
      ...(options.tx ? { db: fromDrizzle(options.tx, sql) } : {}),
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
    });
  }

  async work<T extends object>(queue: string, handler: JobHandler<T>): Promise<void> {
    this.assertKnown(queue);
    const workOptions = { pollingIntervalSeconds: this.opts.pollingIntervalSeconds ?? 1, batchSize: 1 };
    await this.boss.work<Envelope<T>>(queue, workOptions, async (jobs) => {
      for (const job of jobs) {
        const { data, correlationId } = job.data;
        await runWithCorrelation(correlationId, () => handler({ id: job.id, queue, data, correlationId }));
      }
    });
  }

  private assertKnown(queue: string): void {
    if (!this.known.has(queue)) throw new Error(`queue not registered: ${queue}`);
  }
}
