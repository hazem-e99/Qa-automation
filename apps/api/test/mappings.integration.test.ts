import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import { ApiError } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { AUTH_ENV, setupAndSignIn, type Session } from './helpers.js';

let t: TestDatabase;
let api: ApiApp;
let base: string;
let admin: Session;
let dir: string;
let gitRoot: string;

type Lint = { ok: boolean; issues: { severity: string; code: string; value: string }[] };
type Mapping = {
  kind: string;
  entries: { external: string; canonical: string }[];
  discovered: string[] | null;
  version: number;
  lint: Lint;
};
type Mappings = { bindingId: string; defectSync: boolean; mappings: Mapping[] };

const V = (p: string) => `${base}/api/v1${p}`;
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const status = (m: Mappings) => m.mappings.find((x) => x.kind === 'status')!;

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-map-'));
  const keyFile = path.join(dir, 'master.key');
  await writeFile(keyFile, generateMasterKey());
  gitRoot = path.join(dir, 'repos');
  const repo = path.join(gitRoot, 'shop-app');
  await mkdir(repo, { recursive: true });
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo });
  git(['init', '-q', '-b', 'main']);
  await writeFile(path.join(repo, 'README.md'), '# Shop\n');
  git(['add', 'README.md']);
  git(['-c', 'user.name=Dev', '-c', 'user.email=dev@example.test', 'commit', '-q', '-m', 'First']);
  api = await createApiApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_PORT: '0',
    RATE_LIMIT_BURST: '5000',
    RATE_LIMIT_RPS: '5000',
    QOS_MASTER_KEY_FILE: keyFile,
    QOS_DEMO_MODE: 'true',
    QOS_LOCAL_GIT_ROOTS: gitRoot,
    ...AUTH_ENV,
  });
  base = await api.listen();
  admin = await setupAndSignIn(base);
  expect((await admin.fetch(V('/demo/seed'), send('POST'))).status).toBe(200);
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('mapping editor API (T-P2-32)', () => {
  it('starts empty and refuses activation before discovery', async () => {
    const m = await json<Mappings>(await admin.fetch(V('/projects/SHOP/mappings')));
    expect(m.mappings.map((x) => [x.kind, x.discovered, x.version])).toEqual([
      ['status', null, 0],
      ['severity', null, 0],
      ['priority', null, 0],
      ['type', null, 0],
    ]);
    const res = await admin.fetch(V('/projects/SHOP/defect-sync'), send('POST', { enabled: true }));
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json()).code).toBe('mapping.not_discovered');
  });

  it('discovers the tracker values and suggests mappings that lint clean', async () => {
    const list = await json<Mapping[]>(
      await admin.fetch(V('/projects/SHOP/mappings/discover'), send('POST')),
    );
    const st = list.find((x) => x.kind === 'status')!;
    expect(st.discovered).toEqual(['New', 'Active', 'Resolved', 'Closed', 'Removed']);
    expect(st.entries).toContainEqual({ external: 'Closed', canonical: 'closed' });
    for (const m of list) expect(m.lint.ok, m.kind).toBe(true);
    expect(list.find((x) => x.kind === 'type')!.entries).toEqual([{ external: 'Bug', canonical: 'bug' }]);
  });

  it('blocks activation when the provider reports a status that is not mapped (M03-AC-09)', async () => {
    // The tracker's process gains a "Blocked" state and loses "Removed".
    const tracker = (
      await t.pool.query(`select id from integrations.connections where display_name = 'Demo tracker'`)
    ).rows[0].id;
    await admin.fetch(
      V(`/connections/${tracker}/rotate-secret`),
      send('POST', { credential: 'mock-demo-credential;states=New|Active|Blocked|Resolved|Closed' }),
    );
    await admin.fetch(V(`/connections/${tracker}/test`), send('POST'));
    const list = await json<Mapping[]>(
      await admin.fetch(V('/projects/SHOP/mappings/discover'), send('POST')),
    );
    const st = list.find((x) => x.kind === 'status')!;
    expect(st.lint.ok).toBe(false);
    expect(st.lint.issues).toContainEqual({ severity: 'error', code: 'unmapped_external', value: 'Blocked' });
    expect(st.lint.issues).toContainEqual({ severity: 'warning', code: 'stale_external', value: 'Removed' });

    const res = await admin.fetch(V('/projects/SHOP/defect-sync'), send('POST', { enabled: true }));
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json())).toMatchObject({
      code: 'mapping.incomplete',
      params: { unmapped: 'Blocked' },
    });
    const binding = await t.pool.query(
      `select config from projects.project_bindings where role = 'issue_tracker' and project_id = (select id from projects.projects where key = 'SHOP') and ended_at is null`,
    );
    expect(binding.rows[0].config.defectSync).toBeUndefined();
  });

  it('validates a draft without saving, saves with a version check, then activates', async () => {
    const current = status(await json<Mappings>(await admin.fetch(V('/projects/SHOP/mappings'))));
    const entries = [
      ...current.entries.filter((e) => e.external !== 'Removed'),
      { external: 'Blocked', canonical: 'in_progress' },
    ];
    const dry = await json<Lint>(
      await admin.fetch(V('/projects/SHOP/mappings/status/validate'), send('POST', { entries })),
    );
    expect(dry).toEqual({ ok: true, issues: [] });
    const unchanged = status(await json<Mappings>(await admin.fetch(V('/projects/SHOP/mappings'))));
    expect(unchanged.version).toBe(current.version);

    const stale = await admin.fetch(
      V('/projects/SHOP/mappings/status'),
      send('PUT', { expectedVersion: current.version - 1, entries }),
    );
    expect(stale.status).toBe(409);
    const saved = await json<Mapping>(
      await admin.fetch(
        V('/projects/SHOP/mappings/status'),
        send('PUT', { expectedVersion: current.version, entries }),
      ),
    );
    expect(saved).toMatchObject({ version: current.version + 1, lint: { ok: true } });

    const on = await admin.fetch(V('/projects/SHOP/defect-sync'), send('POST', { enabled: true }));
    expect(await on.json()).toMatchObject({ defectSync: true });
    const audit = await t.pool.query(
      `select action from governance.audit_events where action like 'mapping.%' or action like 'binding.defect_sync%' order by created_at`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'mapping.discovered',
      'mapping.discovered',
      'mapping.saved',
      'binding.defect_sync.enabled',
    ]);
  });

  it('answers 404 for a project without a tracker and for unknown kinds', async () => {
    await admin.fetch(V('/projects'), send('POST', { key: 'BARE', name: 'No tracker' }));
    const none = await admin.fetch(V('/projects/BARE/mappings'));
    expect(none.status).toBe(404);
    expect(ApiError.parse(await none.json()).code).toBe('mapping.no_tracker');
    expect(
      (
        await admin.fetch(
          V('/projects/SHOP/mappings/colour'),
          send('PUT', { expectedVersion: 0, entries: [] }),
        )
      ).status,
    ).toBe(404);
  });
});

describe('Local Git through the API (T-P2-05)', () => {
  it('is registered only with configured roots, and connects with a folder instead of a URL', async () => {
    const providers = await json<{ providerType: string }[]>(await admin.fetch(V('/providers')));
    expect(providers.map((p) => p.providerType)).toContain('local_git');
    const res = await admin.fetch(
      V('/connections'),
      send('POST', {
        providerType: 'local_git',
        displayName: 'Local repos',
        authStrategy: 'none',
        baseUrl: gitRoot,
      }),
    );
    expect(res.status).toBe(201);
    const conn = await json<{ id: string; hasCredential: boolean }>(res);
    expect(conn.hasCredential).toBe(false);
    const tested = await json<{
      connection: { status: string };
      capabilities: { capability: string; ok: boolean }[];
    }>(await admin.fetch(V(`/connections/${conn.id}/test`), send('POST')));
    expect(tested.connection.status).toBe('active');
    expect(tested.capabilities.every((c) => c.ok)).toBe(true);
    await admin.fetch(V('/projects'), send('POST', { key: 'LOCAL', name: 'Local project' }));
    expect(
      (
        await admin.fetch(
          V('/projects/LOCAL/bindings'),
          send('POST', { role: 'repository', connectionId: conn.id }),
        )
      ).status,
    ).toBe(201);
  });

  it('refuses relative paths, and a folder outside the roots fails its test', async () => {
    const rel = await admin.fetch(
      V('/connections'),
      send('POST', {
        providerType: 'local_git',
        displayName: 'Relative',
        authStrategy: 'none',
        baseUrl: 'repos/../etc',
      }),
    );
    expect(ApiError.parse(await rel.json()).code).toBe('connection.base_url_invalid');
    const outside = await json<{ id: string }>(
      await admin.fetch(
        V('/connections'),
        send('POST', {
          providerType: 'local_git',
          displayName: 'Outside',
          authStrategy: 'none',
          baseUrl: dir,
        }),
      ),
    );
    const tested = await json<{ connection: { status: string }; errorKind: string }>(
      await admin.fetch(V(`/connections/${outside.id}/test`), send('POST')),
    );
    expect(tested).toMatchObject({ connection: { status: 'degraded' }, errorKind: 'validation' });
  });
});
