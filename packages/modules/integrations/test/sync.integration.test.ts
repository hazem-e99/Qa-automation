import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbEnvelopeSecretStore, generateMasterKey, parseMasterKey } from '@qos/adapters-secrets-db';
import { MockControls, MockRepositoryProvider } from '@qos/adapters-mock';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { uuidv7 } from '@qos/kernel-domain';
import { createLogger } from '@qos/observability';
import {
  breakerState,
  createConnection,
  listSyncRuns,
  ProviderRegistry,
  runSync,
  syncTargets,
  testConnection,
  type IntegrationDeps,
} from '../src/index.js';

const controls = new MockControls();
const repo = new MockRepositoryProvider(controls);
const actor = { orgId: uuidv7(), userId: uuidv7() };
let t: TestDatabase;
let deps: IntegrationDeps;
let projectId: string;
let bindingId: string;
let connectionId: string;
const STREAM = 'repository.commits';

const commits = async () =>
  (
    await t.pool.query(
      "select count(*)::int c, count(distinct external_id)::int d from integrations.external_refs where connection_id = $1 and external_type = 'commit'",
      [connectionId],
    )
  ).rows[0] as { c: number; d: number };

async function bind(repoId: string, project = projectId): Promise<string> {
  const id = uuidv7();
  await t.pool.query(
    `insert into projects.project_bindings (id, project_id, role, connection_id, config, mode, started_at, started_by)
     values ($1, $2, 'repository', $3, $4, 'active', now(), $5)`,
    [id, project, connectionId, JSON.stringify({ repoId }), actor.userId],
  );
  return id;
}

beforeAll(async () => {
  t = await startTestDatabase();
  deps = {
    db: t.db,
    registry: new ProviderRegistry().register(repo),
    secrets: new DbEnvelopeSecretStore(t.db, parseMasterKey(generateMasterKey())),
    http: {
      request: async () => {
        throw new Error('no network');
      },
    },
    logger: createLogger({ service: 'test', level: 'silent' }),
  };
  projectId = uuidv7();
  await t.pool.query(
    `insert into projects.projects (id, org_id, key, name, status, is_demo, created_by, created_at, updated_at)
     values ($1, $2, 'SYNC', 'Sync', 'active', true, $3, now(), now())`,
    [projectId, actor.orgId, actor.userId],
  );
  const c = await createConnection(deps, actor, {
    providerType: 'mock_repository',
    displayName: 'Sync repo',
    authStrategy: 'pat',
    credential: 'mock-token',
  });
  connectionId = c.id;
  await testConnection(deps, actor, connectionId);
  bindingId = await bind('1001');
}, 180_000);
afterAll(async () => {
  await t?.stop();
});
beforeEach(() => controls.reset());

describe('sync framework (T-P2-25)', () => {
  it('a failure mid-way keeps the pages already stored and the next run resumes from the cursor', async () => {
    // Page 1 succeeds, the call for page 2 fails as unavailable.
    const realList = repo.listCommits.bind(repo);
    let calls = 0;
    repo.listCommits = async (...args) => {
      calls++;
      if (calls === 2) controls.failNext('unavailable');
      return realList(...args);
    };
    const first = await runSync(deps, bindingId, STREAM);
    repo.listCommits = realList;
    expect(first).toMatchObject({ status: 'failed', errorKind: 'unavailable', pages: 1, itemsSeen: 20 });
    expect(await commits()).toEqual({ c: 20, d: 20 });
    const errors = await t.pool.query(
      'select kind, message from integrations.sync_errors where sync_run_id = $1',
      [first.runId],
    );
    expect(errors.rows).toEqual([
      { kind: 'unavailable', message: 'sync stopped after 1 page(s): unavailable' },
    ]);

    const second = await runSync(deps, bindingId, STREAM);
    expect(second).toMatchObject({ status: 'succeeded', pages: 2, itemsSeen: 25, itemsChanged: 25 });
    expect(await commits()).toEqual({ c: 45, d: 45 }); // no duplicates, no gaps
  });

  it('an incremental run picks up only new items; a full run re-reads everything without duplicates', async () => {
    expect(await runSync(deps, bindingId, STREAM)).toMatchObject({ status: 'succeeded', itemsSeen: 0 });
    repo.addCommits('1001', 3);
    expect(await runSync(deps, bindingId, STREAM)).toMatchObject({ itemsSeen: 3, itemsChanged: 3 });
    const full = await runSync(deps, bindingId, STREAM, { mode: 'full' });
    expect(full).toMatchObject({ status: 'succeeded', itemsSeen: 48, itemsChanged: 0 });
    expect(await commits()).toEqual({ c: 48, d: 48 });
  });

  it('stops at the page budget and continues in the next run', async () => {
    // A second project: one project may have only one active repository binding.
    const otherProject = uuidv7();
    await t.pool.query(
      `insert into projects.projects (id, org_id, key, name, status, is_demo, created_by, created_at, updated_at)
       values ($1, $2, 'SYNC2', 'Sync 2', 'active', true, $3, now(), now())`,
      [otherProject, actor.orgId, actor.userId],
    );
    const other = await bind('1002', otherProject);
    const partial = await runSync(deps, other, STREAM, { maxPages: 1 });
    expect(partial).toMatchObject({ status: 'partial', pages: 1 });
    const rest = await runSync(deps, other, STREAM, { maxPages: 1 });
    expect(rest).toMatchObject({ status: 'partial', pages: 1 });
    expect(await runSync(deps, other, STREAM)).toMatchObject({ status: 'succeeded', itemsSeen: 5 });
    await t.pool.query('update projects.project_bindings set ended_at = now() where id = $1', [other]);
  });

  it('a rate limit defers the run with the provider retry hint', async () => {
    controls.failNext('rate_limited', 1, 4500);
    expect(await runSync(deps, bindingId, STREAM, { mode: 'full' })).toMatchObject({
      status: 'deferred',
      retryAfterMs: 4500,
    });
  });

  it('never runs twice at once for the same binding and stream', async () => {
    await t.pool.query(
      `insert into integrations.sync_runs (id, binding_id, connection_id, stream, mode, status, started_at)
       values ($1, $2, $3, $4, 'incremental', 'running', now())`,
      [uuidv7(), bindingId, connectionId, STREAM],
    );
    expect(await runSync(deps, bindingId, STREAM)).toMatchObject({
      status: 'skipped',
      reason: 'already_running',
    });
    await t.pool.query("update integrations.sync_runs set status = 'failed' where status = 'running'");
  });

  it('opens the breaker after 5 transient failures within 60 s and probes again after the cooldown', async () => {
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      controls.failNext('timeout');
      await runSync(deps, bindingId, STREAM, { now: () => new Date(start + i * 1000) });
    }
    expect((await breakerState(t.db, connectionId, new Date(start + 5000))).open).toBe(true);
    expect(await runSync(deps, bindingId, STREAM, { now: () => new Date(start + 6000) })).toMatchObject({
      status: 'skipped',
      reason: 'breaker_open',
    });
    // After the cooldown one probe is allowed; it succeeds and closes the breaker.
    const probe = await runSync(deps, bindingId, STREAM, { now: () => new Date(start + 70_000) });
    expect(probe.status).toBe('succeeded');
    expect((await breakerState(t.db, connectionId, new Date(start + 71_000))).open).toBe(false);
  });

  it('skips ended bindings, lists targets and reports runs per project', async () => {
    expect(await syncTargets(t.db)).toEqual([{ bindingId, stream: STREAM }]);
    expect(await syncTargets(t.db, uuidv7())).toEqual([]);
    const runs = await listSyncRuns(t.db, projectId);
    expect(runs.length).toBeGreaterThanOrEqual(10);
    expect(runs.every((r) => r.status !== 'running')).toBe(true);
  });
});
