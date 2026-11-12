import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockRepositoryProvider } from '@qos/adapters-mock';
import { DbEnvelopeSecretStore, generateMasterKey, parseMasterKey } from '@qos/adapters-secrets-db';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { createConnection, ProviderRegistry, testConnection } from '@qos/integrations';
import { uuidv7 } from '@qos/kernel-domain';
import { createLogger } from '@qos/observability';
import { receiveInboxMessage } from '@qos/platform';
// Boot tests run against the compiled output, exactly what `node dist/main.js` runs.
import { createWorkerApp, type WorkerApp } from '../dist/bootstrap.js';

let t: TestDatabase;
let dir: string;
let worker: WorkerApp;
let connectionId: string;
const actor = { orgId: uuidv7(), userId: uuidv7() };

const until = async (cond: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('condition not met in time');
};
const count = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0].c as number;

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-worker-sync-'));
  const key = generateMasterKey();
  await writeFile(path.join(dir, 'master.key'), key);
  // Set up a tested mock connection and a repository binding, as the API would.
  const deps = {
    db: t.db,
    registry: new ProviderRegistry().register(new MockRepositoryProvider()),
    secrets: new DbEnvelopeSecretStore(t.db, parseMasterKey(key)),
    http: { request: async () => Promise.reject(new Error('no network')) },
    logger: createLogger({ service: 'test', level: 'silent' }),
  };
  connectionId = (
    await createConnection(deps, actor, {
      providerType: 'mock_repository',
      displayName: 'Worker repo',
      authStrategy: 'pat',
      credential: 'mock-token',
    })
  ).id;
  await testConnection(deps, actor, connectionId);
  const projectId = uuidv7();
  await t.pool.query(
    `insert into projects.projects (id, org_id, key, name, status, is_demo, created_by, created_at, updated_at)
     values ($1, $2, 'WRK', 'Worker', 'active', true, $3, now(), now())`,
    [projectId, actor.orgId, actor.userId],
  );
  await t.pool.query(
    `insert into projects.project_bindings (id, project_id, role, connection_id, config, mode, started_at, started_by)
     values ($1, $2, 'repository', $3, '{"repoId":"1003"}', 'active', now(), $4)`,
    [uuidv7(), projectId, connectionId, actor.userId],
  );
  worker = await createWorkerApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WORKER_HEALTH_PORT: '0',
    JOB_POLL_SECONDS: '0.5',
    SYNC_POLL_SECONDS: '3600',
    INBOX_POLL_SECONDS: '1',
    QOS_MASTER_KEY_FILE: path.join(dir, 'master.key'),
    QOS_DEMO_MODE: 'true',
  });
}, 180_000);
afterAll(async () => {
  await worker?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('worker sync runtime', () => {
  it('polls active bindings on start and stores the commits as external refs', async () => {
    await until(
      async () =>
        (await count(
          "select count(*)::int c from integrations.external_refs where external_type = 'commit'",
        )) === 45,
    );
    const runs = await t.pool.query('select status, pages from integrations.sync_runs');
    expect(runs.rows).toEqual([{ status: 'succeeded', pages: 3 }]);
  });

  it('a webhook delivery in the inbox triggers a re-fetch through the API, never trusting the payload', async () => {
    const before = await count('select count(*)::int c from integrations.sync_runs');
    const { id } = await receiveInboxMessage(t.db, {
      connectionId,
      dedupeKey: 'delivery:worker-1',
      eventType: 'push',
      verification: 'ok',
      headers: {},
    });
    await until(
      async () =>
        (await count("select count(*)::int c from platform.inbox_messages where status = 'processed'")) === 1,
    );
    await until(
      async () => (await count('select count(*)::int c from integrations.sync_runs')) === before + 1,
    );
    const status = await t.pool.query('select status from platform.inbox_messages where id = $1', [id]);
    expect(status.rows[0].status).toBe('processed');
  });

  it('a delivery for a connection without bindings is ignored as out of scope', async () => {
    const { id } = await receiveInboxMessage(t.db, {
      connectionId: uuidv7(),
      dedupeKey: 'delivery:worker-2',
      eventType: 'push',
      verification: 'ok',
      headers: {},
    });
    await until(
      async () =>
        (await t.pool.query('select status from platform.inbox_messages where id = $1', [id])).rows[0]
          .status !== 'pending',
    );
    expect(
      (await t.pool.query('select status from platform.inbox_messages where id = $1', [id])).rows[0].status,
    ).toBe('ignored_out_of_scope');
  });
});
