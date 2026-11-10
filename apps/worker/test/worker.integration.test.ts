import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthResponse } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { createProbe, getProbe } from '@qos/probe';
// Boot tests run against the compiled output, exactly what `node dist/main.js` runs.
import { createWorkerApp, type WorkerApp } from '../dist/bootstrap.js';

let t: TestDatabase;
let worker: WorkerApp;

beforeAll(async () => {
  t = await startTestDatabase();
  worker = await createWorkerApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WORKER_HEALTH_PORT: '39011',
    JOB_POLL_SECONDS: '0.5',
  });
}, 180_000);
afterAll(async () => {
  await worker?.close();
  await t?.stop();
});

const until = async (cond: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
};

describe('worker', () => {
  it('reports health', async () => {
    const ready = await fetch(`${worker.healthUrl}/readyz`);
    expect(ready.status).toBe(200);
    expect(HealthResponse.parse(await ready.json())).toMatchObject({ service: 'worker', status: 'ok' });
    expect((await fetch(`${worker.healthUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${worker.healthUrl}/other`)).status).toBe(404);
  });

  it('processes the job and the outbox event of a committed command (end to end)', async () => {
    const { id } = await createProbe(
      { db: worker.infra.db, jobs: worker.infra.jobs },
      { label: 'e2e' },
      'tester',
    );
    await until(async () => {
      const p = await getProbe(t.db, id);
      return p?.processedAt != null && p.eventSeenAt != null;
    });
    const pending = await t.pool.query(
      'select count(*)::int c from platform.outbox_events where dispatched_at is null',
    );
    expect(pending.rows[0].c).toBe(0);
  });

  it('reports not ready when the database is gone, and stops cleanly', async () => {
    const other = await startTestDatabase();
    const w = await createWorkerApp({
      DATABASE_URL: other.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_HEALTH_PORT: '39012',
    });
    try {
      await other.pool.end();
      await other.container.stop();
      const ready = await fetch(`${w.healthUrl}/readyz`);
      expect(ready.status).toBe(503);
      expect(HealthResponse.parse(await ready.json()).checks.db?.status).toBe('fail');
      expect((await fetch(`${w.healthUrl}/healthz`)).status).toBe(200);
    } finally {
      await w.close();
    }
  });
});
