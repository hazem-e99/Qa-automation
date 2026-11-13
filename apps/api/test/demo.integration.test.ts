import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockIssueTracker, MockRepositoryProvider } from '@qos/adapters-mock';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import { ApiError } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { checkBindingsHealth } from '@qos/governance';
import { ProviderRegistry, type IntegrationDeps } from '@qos/integrations';
import { SafeHttpClient } from '@qos/kernel-infra';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { AUTH_ENV, setupAndSignIn, signIn, type Session } from './helpers.js';

let t: TestDatabase;
let api: ApiApp;
let base: string;
let admin: Session;
let dir: string;
let keyFile: string;

const env = (extra: Record<string, string> = {}) => ({
  DATABASE_URL: t.url,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_PORT: '0',
  RATE_LIMIT_BURST: '5000',
  RATE_LIMIT_RPS: '5000',
  QOS_MASTER_KEY_FILE: keyFile,
  ...AUTH_ENV,
  ...extra,
});
const V = (p: string) => `${base}/api/v1${p}`;
type Health = { role: string; ok: boolean; connectionStatus: string; missingRequired: string[] };

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-demo-'));
  keyFile = path.join(dir, 'master.key');
  await writeFile(keyFile, generateMasterKey());
  api = await createApiApp(env({ QOS_DEMO_MODE: 'true' }));
  base = await api.listen();
  admin = await setupAndSignIn(base);
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('demo seed (T-P2-04)', () => {
  it('reports demo mode and loads the seed', async () => {
    expect(await (await admin.fetch(V('/demo'))).json()).toEqual({ enabled: true, seeded: false });
    const res = await admin.fetch(V('/demo/seed'), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projects: ['SHOP', 'API'],
      created: {
        projects: ['SHOP', 'API'],
        connections: ['Demo repository', 'Demo tracker'],
        bindings: ['SHOP:repository', 'SHOP:issue_tracker', 'API:repository', 'API:issue_tracker'],
        environments: ['SHOP:staging'],
      },
    });
    expect(await (await admin.fetch(V('/demo'))).json()).toEqual({ enabled: true, seeded: true });
    const projects = (await (await admin.fetch(V('/projects'))).json()) as { key: string; isDemo: boolean }[];
    expect(projects.map((p) => [p.key, p.isDemo]).sort()).toEqual([
      ['API', true],
      ['SHOP', true],
    ]);
  });

  it('is idempotent: a second run creates nothing', async () => {
    const res = await admin.fetch(V('/demo/seed'), { method: 'POST' });
    expect(((await res.json()) as { created: unknown }).created).toEqual({
      projects: [],
      connections: [],
      bindings: [],
      environments: [],
    });
  });

  it('every seeded binding is healthy', async () => {
    const health = (await (await admin.fetch(V('/projects/SHOP/bindings/health'))).json()) as Health[];
    expect(health.map((h) => [h.role, h.ok, h.connectionStatus])).toEqual([
      ['issue_tracker', true, 'active'],
      ['repository', true, 'active'],
    ]);
  });

  it('answers 404 when demo mode is off', async () => {
    const plain = await createApiApp(env());
    const url = await plain.listen();
    try {
      const s = await signIn(url);
      const res = await s.fetch(`${url}/api/v1/demo/seed`, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(ApiError.parse(await res.json()).code).toBe('demo.disabled');
      expect(await (await s.fetch(`${url}/api/v1/demo`)).json()).toEqual({ enabled: false, seeded: false });
    } finally {
      await plain.close();
    }
  });
});

describe('bindings health check (T-P2-17)', () => {
  const deps = (): IntegrationDeps => ({
    db: api.infra.db,
    registry: new ProviderRegistry().register(new MockRepositoryProvider()).register(new MockIssueTracker()),
    secrets: api.secrets,
    http: new SafeHttpClient({ timeoutMs: 5_000, retries: 0 }),
    logger: api.infra.logger,
  });

  it('leaves fresh connections alone and finds nothing wrong', async () => {
    expect(await checkBindingsHealth(deps(), { staleHours: 6 })).toEqual({
      tested: 0,
      testFailures: 0,
      unhealthy: 0,
      notified: 0,
    });
  });

  it('re-tests stale connections and notifies once per binding per day when one degrades', async () => {
    const tracker = (
      await t.pool.query(`select id from integrations.connections where display_name = 'Demo tracker'`)
    ).rows[0].id as string;
    // The credential loses write access (as a narrowed token would); the last test is old.
    await admin.fetch(V(`/connections/${tracker}/rotate-secret`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'mock-demo-credential;scopes=issues:read' }),
    });
    await t.pool.query(`update integrations.connections set last_tested_at = now() - interval '7 hours'`);

    const first = await checkBindingsHealth(deps(), { staleHours: 6 });
    expect(first).toEqual({ tested: 2, testFailures: 0, unhealthy: 2, notified: 2 });
    const second = await checkBindingsHealth(deps(), { staleHours: 6 });
    expect(second).toEqual({ tested: 0, testFailures: 0, unhealthy: 2, notified: 0 });

    const health = (await (await admin.fetch(V('/projects/SHOP/bindings/health'))).json()) as Health[];
    const it = health.find((h) => h.role === 'issue_tracker')!;
    expect(it).toMatchObject({ ok: false, connectionStatus: 'degraded' });
    expect(it.missingRequired).toContain('issues.create@1');

    const { items: notes } = (await (await admin.fetch(V('/me/notifications'))).json()) as {
      items: { type: string; payload: { projectKey: string } }[];
    };
    expect(
      notes
        .filter((n) => n.type === 'binding.unhealthy')
        .map((n) => n.payload.projectKey)
        .sort(),
    ).toEqual(['API', 'SHOP']);
    const audit = await t.pool.query(
      `select count(*)::int as n from governance.audit_events where action = 'binding.unhealthy' and actor_type = 'system'`,
    );
    expect(audit.rows[0].n).toBe(2);
    const tests = await t.pool.query(
      `select count(*)::int as n from governance.audit_events where action = 'connection.tested' and actor_type = 'system'`,
    );
    expect(tests.rows[0].n).toBe(2);
  });
});
