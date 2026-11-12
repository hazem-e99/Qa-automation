import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import { ApiError, BindingResponse, EnvironmentResponse, SettingsResponse } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { AUTH_ENV, setupAndSignIn, type Session } from './helpers.js';

const ENV_SECRET = 'storage-state-value-Kp4{"cookies":[]}';
let t: TestDatabase;
let api: ApiApp;
let base: string;
let admin: Session;
let dir: string;
const logs: string[] = [];

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const code = async (res: Response) => ApiError.parse(await res.json());
const P = (p = '') => `${base}/api/v1/projects/DEMO${p}`;

/** Creates and tests a mock connection; returns its id. */
async function connection(providerType: string, displayName: string, credential: string): Promise<string> {
  const res = await admin.fetch(
    `${base}/api/v1/connections`,
    send('POST', { providerType, displayName, authStrategy: 'pat', credential }),
  );
  const { id } = (await res.json()) as { id: string };
  await admin.fetch(`${base}/api/v1/connections/${id}/test`, send('POST'));
  return id;
}

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-cfg-'));
  await writeFile(path.join(dir, 'master.key'), generateMasterKey());
  api = await createApiApp(
    {
      DATABASE_URL: t.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
      API_PORT: '39181',
      RATE_LIMIT_BURST: '5000',
      RATE_LIMIT_RPS: '5000',
      QOS_MASTER_KEY_FILE: path.join(dir, 'master.key'),
      QOS_DEMO_MODE: 'true',
      ...AUTH_ENV,
    },
    { logDestination: { write: (line: string) => void logs.push(line) } },
  );
  base = await api.listen();
  admin = await setupAndSignIn(base);
  await admin.fetch(
    `${base}/api/v1/projects`,
    send('POST', { key: 'DEMO', name: 'Demo project', isDemo: true }),
  );
  await admin.fetch(`${base}/api/v1/projects`, send('POST', { key: 'REAL', name: 'Real project' }));
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('environments (M02-FR-03, M02-AC-05)', () => {
  let id: string;

  it('creates an environment; the auth secret is write-only', async () => {
    const res = await admin.fetch(
      P('/environments'),
      send('POST', {
        name: 'staging',
        baseUrls: ['https://staging.app.example.test/'],
        allowedHosts: ['staging.app.example.test', '*.cdn.example.test'],
        authSecret: ENV_SECRET,
        tags: ['QA'],
      }),
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('storage-state-value');
    const e = EnvironmentResponse.parse(JSON.parse(text));
    expect(e).toMatchObject({ name: 'staging', hasAuthSecret: true, isProduction: false, tags: ['qa'] });
    id = e.id;
    const list = await (await admin.fetch(P('/environments'))).text();
    expect(list).not.toContain('storage-state-value');
  });

  it('derives the allow-list from base URLs and refuses hosts outside it', async () => {
    const derived = EnvironmentResponse.parse(
      await (
        await admin.fetch(
          P('/environments'),
          send('POST', { name: 'local', baseUrls: ['http://127.0.0.1:8080'] }),
        )
      ).json(),
    );
    expect(derived.allowedHosts).toEqual(['127.0.0.1']);
    const outside = await admin.fetch(
      P('/environments'),
      send('POST', { name: 'bad', baseUrls: ['https://a.example.test'], allowedHosts: ['b.example.test'] }),
    );
    expect(outside.status).toBe(422);
    expect((await code(outside)).code).toBe('environment.host_not_allowed');
    const hook = await admin.fetch(
      P('/environments'),
      send('POST', {
        name: 'bad2',
        baseUrls: ['https://a.example.test'],
        resetHookUrl: 'https://evil.example.test/reset',
      }),
    );
    expect((await code(hook)).code).toBe('environment.host_not_allowed');
    for (const baseUrls of [['ftp://x.example.test'], ['https://user:pw@x.example.test'], ['nope']]) {
      expect((await admin.fetch(P('/environments'), send('POST', { name: 'u', baseUrls }))).status).toBe(422);
    }
    expect(
      (
        await admin.fetch(
          P('/environments'),
          send('POST', { name: 'staging', baseUrls: ['https://staging.app.example.test'] }),
        )
      ).status,
    ).toBe(409);
  });

  it('keeps, replaces or removes the auth secret on update', async () => {
    const put = (body: Record<string, unknown>) =>
      admin.fetch(
        P(`/environments/${id}`),
        send('PUT', { name: 'staging', baseUrls: ['https://staging.app.example.test'], ...body }),
      );
    expect(EnvironmentResponse.parse(await (await put({})).json()).hasAuthSecret).toBe(true);
    expect(
      EnvironmentResponse.parse(await (await put({ authSecret: 'new-storage-state-value' })).json())
        .hasAuthSecret,
    ).toBe(true);
    expect(EnvironmentResponse.parse(await (await put({ authSecret: null })).json()).hasAuthSecret).toBe(
      false,
    );
    expect(
      (await t.pool.query("select count(*)::int c from governance.secrets where owner_type = 'environment'"))
        .rows[0].c,
    ).toBe(0);
  });

  it('never logs or audits the secret value', async () => {
    const audit = JSON.stringify((await t.pool.query('select summary from governance.audit_events')).rows);
    expect(audit).not.toContain('storage-state-value');
    expect(logs.join('')).not.toContain('storage-state-value');
  });
});

describe('bindings (BR-M02-2/3/4, M02-AC-02)', () => {
  it('rejects a connection that lacks required capabilities, listing what is missing', async () => {
    const weak = await connection('mock_issue_tracker', 'Weak tracker', 'mock-token;scopes=issues:read');
    const res = await admin.fetch(
      P('/bindings'),
      send('POST', { role: 'issue_tracker', connectionId: weak }),
    );
    expect(res.status).toBe(422);
    const body = await code(res);
    expect(body.code).toBe('binding.capabilities_missing');
    expect(String(body.params.missing).split(',')).toEqual(['issues.create@1', 'issues.update@1']);
    const wrongFamily = await admin.fetch(
      P('/bindings'),
      send('POST', { role: 'repository', connectionId: weak }),
    );
    expect((await code(wrongFamily)).params.familyMismatch).toBe(true);
  });

  it('binds a qualifying connection, with optional gaps as warnings', async () => {
    const repo = await connection('mock_repository', 'Demo repo', 'mock-token-full');
    const res = await admin.fetch(
      P('/bindings'),
      send('POST', { role: 'repository', connectionId: repo, config: { repoId: '1001' } }),
    );
    expect(res.status).toBe(201);
    const b = BindingResponse.parse(await res.json());
    expect(b).toMatchObject({
      role: 'repository',
      mode: 'active',
      endedAt: null,
      config: { repoId: '1001' },
    });
    expect(b.warnings).toEqual(['repo.diff.read@1', 'repo.webhooks.manage@1', 'repo.checks.report@1']);
    expect(
      (await admin.fetch(P('/bindings'), send('POST', { role: 'repository', connectionId: repo }))).status,
    ).toBe(409);
  });

  it('replacing a binding ends the old one and keeps it in the history', async () => {
    const first = await connection('mock_issue_tracker', 'Tracker A', 'mock-token-full');
    const second = await connection('mock_issue_tracker', 'Tracker B', 'mock-token-full');
    await admin.fetch(P('/bindings'), send('POST', { role: 'issue_tracker', connectionId: first }));
    await admin.fetch(P('/bindings'), send('POST', { role: 'issue_tracker', connectionId: second }));
    const active = BindingResponse.array().parse(await (await admin.fetch(P('/bindings'))).json());
    expect(active.filter((b) => b.role === 'issue_tracker').map((b) => b.connectionId)).toEqual([second]);
    const history = BindingResponse.array().parse(
      await (await admin.fetch(P('/bindings?history=true'))).json(),
    );
    const trackers = history.filter((b) => b.role === 'issue_tracker');
    expect(trackers).toHaveLength(2);
    expect(trackers.find((b) => b.connectionId === first)?.endedAt).not.toBeNull();
    const events = await t.pool.query(
      "select count(*)::int c from platform.outbox_events where type = 'project.binding.changed'",
    );
    expect(events.rows[0].c).toBeGreaterThanOrEqual(3);
  });

  it('demo connections cannot be bound to a real project; ending a binding works once', async () => {
    const repo = await connection('mock_repository', 'Demo repo 2', 'mock-token-full');
    const res = await admin.fetch(
      `${base}/api/v1/projects/REAL/bindings`,
      send('POST', { role: 'repository', connectionId: repo }),
    );
    expect(res.status).toBe(422);
    expect((await code(res)).code).toBe('binding.demo_connection');
    const [b] = BindingResponse.array()
      .parse(await (await admin.fetch(P('/bindings'))).json())
      .filter((x) => x.role === 'repository');
    expect((await admin.fetch(P(`/bindings/${b!.id}`), send('DELETE'))).status).toBe(204);
    expect((await admin.fetch(P(`/bindings/${b!.id}`), send('DELETE'))).status).toBe(404);
  });
});

describe('settings (BR-M02-6, M02-AC-08)', () => {
  it('serves defaults before the first save', async () => {
    const s = SettingsResponse.parse(await (await admin.fetch(P('/settings/execution'))).json());
    expect(s).toMatchObject({
      section: 'execution',
      version: 0,
      data: { maxParallelRuns: 2, allowForkPullRequests: false },
    });
    expect((await admin.fetch(P('/settings/unknown'))).status).toBe(404);
  });

  it('every change writes a history version and an audit event; stale versions are refused', async () => {
    const put = (expectedVersion: number, data: Record<string, unknown>) =>
      admin.fetch(P('/settings/execution'), send('PUT', { expectedVersion, data }));
    const v1 = SettingsResponse.parse(await (await put(0, { maxParallelRuns: 3 })).json());
    expect(v1).toMatchObject({ version: 1, data: { maxParallelRuns: 3, retries: 1 } });
    const v2 = SettingsResponse.parse(await (await put(1, { maxParallelRuns: 3, retries: 2 })).json());
    expect(v2.version).toBe(2);
    const stale = await put(1, { retries: 0 });
    expect(stale.status).toBe(409);
    expect((await code(stale)).params.currentVersion).toBe(2);

    const history = (await (await admin.fetch(P('/settings/execution/history'))).json()) as {
      version: number;
    }[];
    expect(history.map((h) => h.version)).toEqual([2, 1]);
    const audits = await t.pool.query(
      "select summary from governance.audit_events where action = 'project.settings.changed' order by created_at",
    );
    expect(audits.rows.map((r) => r.summary.changed)).toEqual([['maxParallelRuns'], ['retries']]);
  });

  it('validates each section against its schema', async () => {
    const bad = await admin.fetch(
      P('/settings/execution'),
      send('PUT', { expectedVersion: 2, data: { maxParallelRuns: 99, browsers: ['netscape'] } }),
    );
    expect(bad.status).toBe(422);
    const body = await code(bad);
    expect(body.code).toBe('settings.invalid');
    expect(String(body.params.fields)).toContain('maxParallelRuns');
    const regex = await admin.fetch(
      P('/settings/testing_rules'),
      send('PUT', { expectedVersion: 0, data: { titlePattern: '([' } }),
    );
    expect(regex.status).toBe(422);
  });

  it('an archived project refuses configuration writes', async () => {
    await admin.fetch(
      `${base}/api/v1/projects`,
      send('POST', { key: 'OLD', name: 'Old project', isDemo: true }),
    );
    await admin.fetch(`${base}/api/v1/projects/OLD/archive`, send('POST'));
    const O = (p: string) => `${base}/api/v1/projects/OLD${p}`;
    expect(
      (await admin.fetch(O('/settings/quality'), send('PUT', { expectedVersion: 0, data: {} }))).status,
    ).toBe(409);
    expect(
      (
        await admin.fetch(
          O('/environments'),
          send('POST', { name: 'x', baseUrls: ['https://x.example.test'] }),
        )
      ).status,
    ).toBe(409);
    expect((await admin.fetch(O('/settings/quality'))).status).toBe(200);
  });
});
