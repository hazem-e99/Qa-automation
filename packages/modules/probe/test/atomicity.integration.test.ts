import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBE_CREATED_EVENT } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { ALL_QUEUES, OutboxDispatcher, PgBossJobQueue, QUEUES } from '@qos/jobs';
import { createLogger, runWithCorrelation } from '@qos/observability';
import { createProbe, getProbe, onProbeCreated, processProbeJob, type ProbeJobData } from '../src/index.js';

const logger = createLogger({ service: 'test', level: 'silent' });
let t: TestDatabase;
let jobs: PgBossJobQueue;

beforeAll(async () => {
  t = await startTestDatabase();
  jobs = new PgBossJobQueue({
    connectionString: t.url,
    queues: ALL_QUEUES,
    logger,
    supervise: true,
    pollingIntervalSeconds: 0.5,
  });
  await jobs.start();
}, 180_000);
afterAll(async () => {
  await jobs?.stop();
  await t?.stop();
});

const count = async (table: string) =>
  (await t.pool.query(`select count(*)::int c from ${table}`)).rows[0].c as number;
const snapshot = async () => ({
  probes: await count('platform.probes'),
  audit: await count('governance.audit_events'),
  outbox: await count('platform.outbox_events'),
  jobs: (
    await t.pool.query('select count(*)::int c from pgboss.job where name = $1', [QUEUES.probeProcess.name])
  ).rows[0].c as number,
});
const until = async (cond: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
};

describe('P1 acceptance: atomic command', () => {
  it('commit writes the domain row, audit, outbox event and job together', async () => {
    const before = await snapshot();
    const { id } = await runWithCorrelation('corr-atomic-0001', () =>
      createProbe({ db: t.db, jobs }, { label: 'commit' }, 'tester'),
    );
    const after = await snapshot();
    expect(after).toEqual({
      probes: before.probes + 1,
      audit: before.audit + 1,
      outbox: before.outbox + 1,
      jobs: before.jobs + 1,
    });
    const ev = await t.pool.query(
      'select type, correlation_id from platform.outbox_events where aggregate_id = $1',
      [id],
    );
    expect(ev.rows[0]).toEqual({ type: PROBE_CREATED_EVENT, correlation_id: 'corr-atomic-0001' });
    const au = await t.pool.query('select correlation_id from governance.audit_events where target_id = $1', [
      id,
    ]);
    expect(au.rows[0].correlation_id).toBe('corr-atomic-0001');
  });

  it('a forced failure after all writes leaves none of them', async () => {
    const before = await snapshot();
    await expect(
      createProbe({ db: t.db, jobs }, { label: 'rollback', failAfterWrites: true }, 'tester'),
    ).rejects.toThrow('probe.forced_failure');
    expect(await snapshot()).toEqual(before);
  });
});

describe('outbox dispatcher', () => {
  it('delivers pending events to internal subscribers and marks them dispatched', async () => {
    const dispatcher = new OutboxDispatcher({ db: t.db, connectionString: t.url, logger });
    dispatcher.subscribe(PROBE_CREATED_EVENT, 'probe.seen', onProbeCreated);
    const { id } = await createProbe({ db: t.db, jobs }, { label: 'dispatch' }, 'tester');
    expect(await dispatcher.drain()).toBeGreaterThanOrEqual(1);
    expect((await getProbe(t.db, id))?.eventSeenAt).toBeInstanceOf(Date);
    expect(await count('platform.outbox_events where dispatched_at is null')).toBe(0);
    expect(await dispatcher.drain()).toBe(0);
  });

  it('retries an event whose subscriber failed (at-least-once) and the subscriber dedupes', async () => {
    const dispatcher = new OutboxDispatcher({ db: t.db, connectionString: t.url, logger });
    let calls = 0;
    dispatcher.subscribe(PROBE_CREATED_EVENT, 'flaky', async (event, tx) => {
      calls++;
      await onProbeCreated(event, tx);
      if (calls === 1) throw new Error('subscriber crashed after its write');
    });
    const { id } = await createProbe({ db: t.db, jobs }, { label: 'retry' }, 'tester');
    expect(await dispatcher.drain()).toBe(0); // first attempt fails and rolls back
    expect((await getProbe(t.db, id))?.eventSeenAt).toBeNull();
    expect(await dispatcher.drain()).toBe(1); // second attempt succeeds
    const first = (await getProbe(t.db, id))?.eventSeenAt;
    expect(first).toBeInstanceOf(Date);
    expect(calls).toBe(2);
  });

  it('two dispatchers never dispatch the same event twice', async () => {
    const seen: string[] = [];
    const make = () => {
      const d = new OutboxDispatcher({ db: t.db, connectionString: t.url, logger });
      d.subscribe(PROBE_CREATED_EVENT, 'count', async (event) => {
        seen.push(event.eventId);
        await new Promise((r) => setTimeout(r, 20));
      });
      return d;
    };
    for (let i = 0; i < 10; i++) await createProbe({ db: t.db, jobs }, { label: `race-${i}` }, 'tester');
    const [a, b] = await Promise.all([make().drain(), make().drain()]);
    expect(a + b).toBe(10);
    expect(new Set(seen).size).toBe(10);
    expect(seen.length).toBe(10);
  });

  it('wakes up on NOTIFY without waiting for the poll interval', async () => {
    const dispatcher = new OutboxDispatcher({
      db: t.db,
      connectionString: t.url,
      logger,
      pollIntervalMs: 60_000,
    });
    dispatcher.subscribe(PROBE_CREATED_EVENT, 'probe.seen', onProbeCreated);
    await dispatcher.start();
    try {
      await new Promise((r) => setTimeout(r, 300)); // let the initial drain finish
      const { id } = await createProbe({ db: t.db, jobs }, { label: 'notify' }, 'tester');
      await until(async () => (await getProbe(t.db, id))?.eventSeenAt != null, 5_000);
    } finally {
      await dispatcher.stop();
    }
  });
});

describe('job processing', () => {
  it('a worker processes the job, keeps the correlation id, and a redelivery changes nothing', async () => {
    const correlations: (string | null)[] = [];
    let last: { id: string; data: ProbeJobData } | null = null;
    await jobs.work<ProbeJobData>(QUEUES.probeProcess.name, async (job) => {
      correlations.push(job.correlationId);
      last = { id: job.id, data: job.data };
      await processProbeJob(t.db, job);
    });
    const { id } = await runWithCorrelation('corr-job-000001', () =>
      createProbe({ db: t.db, jobs }, { label: 'work' }, 'tester'),
    );
    await until(async () => (await getProbe(t.db, id))?.processedAt != null);
    expect(correlations).toContain('corr-job-000001');
    const processedAt = (await getProbe(t.db, id))!.processedAt;
    // Simulated redelivery of the same job: the expected-state update makes it a no-op.
    const again = await processProbeJob(t.db, {
      id: 'redelivery',
      queue: QUEUES.probeProcess.name,
      data: { probeId: id },
      correlationId: null,
    });
    expect(again.changed).toBe(false);
    expect((await getProbe(t.db, id))!.processedAt).toEqual(processedAt);
    expect(last).not.toBeNull();
  });

  it('refuses to send to a queue that is not in the registry', async () => {
    await expect(jobs.send('not.registered', {})).rejects.toThrow('queue not registered');
  });
});
