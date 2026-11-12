import type { Tx } from '@qos/db';
import { runSync, syncTargets, type IntegrationDeps } from '@qos/integrations';
import { QUEUES, type PgBossJobQueue } from '@qos/jobs';
import { InboxProcessor } from '@qos/platform';

export interface SyncJobData {
  readonly bindingId: string;
  readonly stream: string;
  readonly mode?: 'incremental' | 'full';
}

const key = (d: SyncJobData) => `${d.bindingId}:${d.stream}`;

/** Enqueues a sync. The stately queue keeps at most one queued and one running job per key. */
export function enqueueSync(
  jobs: PgBossJobQueue,
  data: SyncJobData,
  opts: { tx?: Tx; startAfterSeconds?: number } = {},
) {
  return jobs.send<SyncJobData>(QUEUES.integrationsSync.name, data, {
    singletonKey: key(data),
    ...(opts.tx ? { tx: opts.tx } : {}),
    ...(opts.startAfterSeconds ? { startAfterSeconds: opts.startAfterSeconds } : {}),
  });
}

/**
 * Sync and ingress runtime of the worker (doc 13 §1, ADR-0014):
 *  - the sync job runs one stream and re-queues itself when the page budget ran out or the
 *    provider asked to wait;
 *  - the poller enqueues every active stream on a fixed interval (polling is always on);
 *  - the inbox processor turns webhook deliveries into syncs of the affected bindings, so the
 *    payload itself is never trusted: the data come from the provider's API.
 */
export class SyncRuntime {
  private pollTimer: NodeJS.Timeout | null = null;
  private inboxTimer: NodeJS.Timeout | null = null;
  private readonly inbox: InboxProcessor;
  private stopped = false;

  constructor(
    private readonly deps: IntegrationDeps,
    private readonly jobs: PgBossJobQueue,
    private readonly opts: { pollSeconds: number; inboxSeconds: number },
  ) {
    this.inbox = new InboxProcessor({ db: deps.db, logger: deps.logger });
    // Source-control events: re-fetch through the sync streams of every binding on that connection.
    for (const eventType of ['push', 'pull_request', 'create']) {
      this.inbox.register(eventType, async (message, tx) => {
        const targets = await syncTargets(this.deps.db, message.connectionId);
        if (targets.length === 0) return 'ignored_out_of_scope';
        for (const t of targets) await enqueueSync(this.jobs, t, { tx });
        return 'processed';
      });
    }
  }

  async start(): Promise<void> {
    await this.jobs.work<SyncJobData>(QUEUES.integrationsSync.name, async (job) => {
      const result = await runSync(this.deps, job.data.bindingId, job.data.stream, {
        ...(job.data.mode ? { mode: job.data.mode } : {}),
      });
      this.deps.logger.info(
        { jobId: job.id, ...job.data, status: result.status, items: result.itemsSeen },
        'sync job done',
      );
      if (this.stopped) return;
      if (result.status === 'partial') await enqueueSync(this.jobs, { ...job.data, mode: 'incremental' });
      if (result.status === 'deferred') {
        await enqueueSync(
          this.jobs,
          { ...job.data, mode: 'incremental' },
          {
            startAfterSeconds: Math.ceil((result.retryAfterMs ?? 60_000) / 1000),
          },
        );
      }
      // Failures are recorded on the run; the next poll retries, and the breaker limits the pace.
    });
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.opts.pollSeconds * 1000);
    this.inboxTimer = setInterval(() => void this.drainInbox(), this.opts.inboxSeconds * 1000);
    this.pollTimer.unref();
    this.inboxTimer.unref();
  }

  async poll(): Promise<number> {
    try {
      const targets = await syncTargets(this.deps.db);
      for (const t of targets) await enqueueSync(this.jobs, t);
      return targets.length;
    } catch (err) {
      this.deps.logger.error({ err }, 'sync poll failed');
      return 0;
    }
  }

  async drainInbox(): Promise<number> {
    try {
      return await this.inbox.drain();
    } catch (err) {
      this.deps.logger.error({ err }, 'inbox drain failed');
      return 0;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.inboxTimer) clearInterval(this.inboxTimer);
  }
}
