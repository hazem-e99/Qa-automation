import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import { ApiError, ProjectTemplateResponse } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { AUTH_ENV, setupAndSignIn, type Session } from './helpers.js';

let t: TestDatabase;
let api: ApiApp;
let base: string;
let admin: Session;
let dir: string;
const SECRET = 'storage-state-secret-value-7Qx';

const V = (p: string) => `${base}/api/v1${p}`;
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const json = async <T>(res: Response) => (await res.json()) as T;
type Settings = { version: number; data: Record<string, unknown> };
type Env = { name: string; hasAuthSecret: boolean; baseUrls: string[] };

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-tpl-'));
  const keyFile = path.join(dir, 'master.key');
  await writeFile(keyFile, generateMasterKey());
  api = await createApiApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_PORT: '0',
    RATE_LIMIT_BURST: '5000',
    RATE_LIMIT_RPS: '5000',
    QOS_MASTER_KEY_FILE: keyFile,
    QOS_DEMO_MODE: 'true',
    ...AUTH_ENV,
  });
  base = await api.listen();
  admin = await setupAndSignIn(base);
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('project templates and cloning (T-P2-14)', () => {
  let templateId: string;

  it('lists the built-in templates', async () => {
    const list = ProjectTemplateResponse.array().parse(
      await json(await admin.fetch(V('/project-templates'))),
    );
    expect(list.map((x) => [x.id, x.builtin])).toEqual([
      ['builtin-web-app', true],
      ['builtin-api-service', true],
    ]);
  });

  it('creates a project from a built-in template, atomically with its settings', async () => {
    const res = await admin.fetch(
      V('/projects'),
      send('POST', { key: 'WEB', name: 'Web shop', templateId: 'builtin-web-app' }),
    );
    expect(res.status).toBe(201);
    const exec = await json<Settings>(await admin.fetch(V('/projects/WEB/settings/execution')));
    expect(exec.version).toBe(1);
    expect(exec.data.browsers).toEqual(['chromium', 'firefox']);
    expect(exec.data.maxParallelRuns).toBe(2); // untouched fields keep their defaults
    const unknown = await admin.fetch(
      V('/projects'),
      send('POST', { key: 'BAD', name: 'Bad', templateId: 'builtin-nope' }),
    );
    expect(unknown.status).toBe(404);
    // Nothing of the failed creation remains: the key is still free.
    expect((await admin.fetch(V('/projects'), send('POST', { key: 'BAD', name: 'Bad' }))).status).toBe(201);
  });

  it('saves a project as an organization template without its secrets', async () => {
    await admin.fetch(V('/projects'), send('POST', { key: 'SRC', name: 'Source', isDemo: true }));
    await admin.fetch(
      V('/projects/SRC/environments'),
      send('POST', { name: 'staging', baseUrls: ['https://staging.shop.example.test'], authSecret: SECRET }),
    );
    await admin.fetch(
      V('/projects/SRC/settings/quality'),
      send('PUT', { expectedVersion: 0, data: { requirementCoverageTargetPct: 95, flakyThresholdPct: 1 } }),
    );
    const res = await admin.fetch(
      V('/projects/SRC/save-as-template'),
      send('POST', { name: 'Shop standard' }),
    );
    expect(res.status).toBe(201);
    const tpl = ProjectTemplateResponse.parse(await res.json());
    templateId = tpl.id;
    expect(tpl).toMatchObject({ builtin: false, settingsSections: ['quality'], environments: ['staging'] });
    const rows = JSON.stringify((await t.pool.query('select data from projects.project_templates')).rows);
    expect(rows).not.toContain(SECRET);
    const dup = await admin.fetch(
      V('/projects/SRC/save-as-template'),
      send('POST', { name: 'Shop standard' }),
    );
    expect(dup.status).toBe(409);
  });

  it('creates from the organization template: environments come without test logins', async () => {
    await admin.fetch(V('/projects'), send('POST', { key: 'NEW', name: 'New shop', templateId }));
    const envs = await json<Env[]>(await admin.fetch(V('/projects/NEW/environments')));
    expect(envs).toEqual([expect.objectContaining({ name: 'staging', hasAuthSecret: false })]);
    const quality = await json<Settings>(await admin.fetch(V('/projects/NEW/settings/quality')));
    expect(quality.data.requirementCoverageTargetPct).toBe(95);
    const row = await t.pool.query(`select template_id from projects.projects where key = 'NEW'`);
    expect(row.rows[0].template_id).toBe(templateId);
  });

  it('clones configuration and bindings into a new project of the same kind', async () => {
    const conn = await json<{ id: string }>(
      await admin.fetch(
        V('/connections'),
        send('POST', {
          providerType: 'mock_repository',
          displayName: 'Repo',
          authStrategy: 'pat',
          credential: 'mock-full',
        }),
      ),
    );
    await admin.fetch(V(`/connections/${conn.id}/test`), send('POST'));
    expect(
      (
        await admin.fetch(
          V('/projects/SRC/bindings'),
          send('POST', { role: 'repository', connectionId: conn.id }),
        )
      ).status,
    ).toBe(201);

    const res = await admin.fetch(V('/projects/SRC/clone'), send('POST', { key: 'CLN', name: 'Clone' }));
    expect(res.status).toBe(201);
    const out = await json<{ project: { key: string; isDemo: boolean }; skippedBindings: unknown[] }>(res);
    expect(out).toMatchObject({ project: { key: 'CLN', isDemo: true }, skippedBindings: [] });
    const bindings = await json<{ role: string; connectionId: string }[]>(
      await admin.fetch(V('/projects/CLN/bindings')),
    );
    expect(bindings).toEqual([expect.objectContaining({ role: 'repository', connectionId: conn.id })]);
    const envs = await json<Env[]>(await admin.fetch(V('/projects/CLN/environments')));
    expect(envs.map((e) => [e.name, e.hasAuthSecret])).toEqual([['staging', false]]);
    const again = await admin.fetch(V('/projects/SRC/clone'), send('POST', { key: 'CLN', name: 'Clone' }));
    expect(ApiError.parse(await again.json()).code).toBe('project.key_taken');
  });

  it('built-in templates cannot be deleted; organization ones can', async () => {
    const builtin = await admin.fetch(V('/project-templates/builtin-web-app'), send('DELETE'));
    expect(ApiError.parse(await builtin.json()).code).toBe('template.builtin');
    expect((await admin.fetch(V(`/project-templates/${templateId}`), send('DELETE'))).status).toBe(204);
    expect((await admin.fetch(V(`/project-templates/${templateId}`), send('DELETE'))).status).toBe(404);
  });
});
