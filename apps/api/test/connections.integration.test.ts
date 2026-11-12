import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import {
  ApiError,
  ConnectionResponse,
  ConnectionTestResponse,
  ProviderResponse,
  RoleCheckResponse,
} from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { hashPassword } from '@qos/identity';
import { uuidv7 } from '@qos/kernel-domain';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { AUTH_ENV, setupAndSignIn, signIn, type Session } from './helpers.js';

const CREDENTIAL = 'mock-api-credential-9Zt;scopes=issues:read';
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
const C = (p = '') => `${base}/api/v1/connections${p}`;

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-conn-'));
  const keyFile = path.join(dir, 'master.key');
  await writeFile(keyFile, generateMasterKey());
  api = await createApiApp(
    {
      DATABASE_URL: t.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
      API_PORT: '39071',
      RATE_LIMIT_BURST: '5000',
      RATE_LIMIT_RPS: '5000',
      QOS_MASTER_KEY_FILE: keyFile,
      QOS_DEMO_MODE: 'true',
      ...AUTH_ENV,
    },
    { logDestination: { write: (line: string) => void logs.push(line) } },
  );
  base = await api.listen();
  admin = await setupAndSignIn(base);
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('connections API', () => {
  let id: string;

  it('lists the provider catalog', async () => {
    const providers = ProviderResponse.array().parse(
      await (await admin.fetch(`${base}/api/v1/providers`)).json(),
    );
    expect(providers.map((p) => p.providerType)).toEqual(['mock_issue_tracker', 'mock_repository']);
    expect(providers.every((p) => p.demoOnly)).toBe(true);
  });

  it('creates a connection; the credential is write-only and never echoed', async () => {
    const res = await admin.fetch(
      C(),
      send('POST', {
        providerType: 'mock_issue_tracker',
        displayName: 'Demo tracker',
        authStrategy: 'pat',
        credential: CREDENTIAL,
      }),
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('mock-api-credential');
    const c = ConnectionResponse.parse(JSON.parse(text));
    expect(c).toMatchObject({ status: 'untested', hasCredential: true, isDemo: true });
    id = c.id;
    for (const url of [C(), C(`/${id}`)])
      expect(await (await admin.fetch(url)).text()).not.toContain('mock-api-credential');
  });

  it('tests the connection and rejects it as issue tracker for missing write capabilities (M03-AC-01)', async () => {
    const outcome = ConnectionTestResponse.parse(
      await (await admin.fetch(C(`/${id}/test`), send('POST'))).json(),
    );
    expect(outcome.connection.status).toBe('degraded');
    expect(outcome.capabilities.find((c) => c.capability === 'issues.create@1')).toMatchObject({ ok: false });
    const diff = RoleCheckResponse.parse(
      await (await admin.fetch(C(`/${id}/role-check?role=issue_tracker`))).json(),
    );
    expect(diff.ok).toBe(false);
    expect(diff.missingRequired).toContain('issues.create@1');
    expect((await admin.fetch(C(`/${id}/role-check?role=wizard`))).status).toBe(422);
  });

  it('rotates the credential; afterwards the connection qualifies', async () => {
    const rotated = await admin.fetch(
      C(`/${id}/rotate-secret`),
      send('POST', { credential: 'mock-api-credential-full' }),
    );
    expect(ConnectionResponse.parse(await rotated.json()).status).toBe('untested');
    await admin.fetch(C(`/${id}/test`), send('POST'));
    const diff = RoleCheckResponse.parse(
      await (await admin.fetch(C(`/${id}/role-check?role=issue_tracker`))).json(),
    );
    expect(diff.ok).toBe(true);
    const checks = (await (await admin.fetch(C(`/${id}/checks`))).json()) as unknown[];
    expect(checks.length).toBe(2);
  });

  it('retires the connection and keeps it listed as retired', async () => {
    expect(await (await admin.fetch(C(`/${id}/impact`))).json()).toEqual({ externalRefs: {} });
    const res = await admin.fetch(C(`/${id}/retire`), send('POST'));
    expect(ConnectionResponse.parse(await res.json())).toMatchObject({
      status: 'retired',
      hasCredential: false,
    });
    const again = await admin.fetch(C(`/${id}/test`), send('POST'));
    expect(again.status).toBe(409);
    expect(ApiError.parse(await again.json()).code).toBe('connection.retired');
  });

  it('is limited to administrators; unknown ids are 404', async () => {
    const userId = uuidv7();
    const org = (await t.pool.query('select id from identity.organizations')).rows[0].id;
    await t.pool.query(
      `insert into identity.users (id, org_id, email, display_name, password_hash, status, created_at)
       values ($1, $2, 'member@example.test', 'Member', $3, 'active', now())`,
      [userId, org, await hashPassword('member long password')],
    );
    const member = await signIn(base, 'member@example.test', 'member long password');
    expect((await member.fetch(C())).status).toBe(403);
    expect((await member.fetch(`${base}/api/v1/providers`)).status).toBe(200);
    expect((await admin.fetch(C(`/${uuidv7()}`))).status).toBe(404);
  });

  it('never writes a credential to the logs (M03-AC-06)', () => {
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain('mock-api-credential');
  });
});
