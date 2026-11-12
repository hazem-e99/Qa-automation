import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { listRoutes } from '../dist/route-inventory.js';
import { AUTH_ENV, setupAndSignIn, type Session } from './helpers.js';

let t: TestDatabase;
let api: ApiApp;
let base: string;
let admin: Session;
let dir: string;
let connectionId: string;
let hookPath: string;
let secret: string;
const logs: string[] = [];

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const deliver = (body: string, headers: Record<string, string>, p = hookPath) =>
  fetch(`${api.webhookUrl}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
const signed = (body: string, delivery: string, key = secret) => ({
  'x-mock-signature': `sha256=${createHmac('sha256', key).update(body).digest('hex')}`,
  'x-mock-delivery': delivery,
  'x-mock-event': 'push',
});
const inbox = async () =>
  (
    await t.pool.query(
      'select status, verification, body_ref, error from platform.inbox_messages where connection_id = $1 order by received_at',
      [connectionId],
    )
  ).rows as { status: string; verification: string; body_ref: string | null; error: string | null }[];

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-hook-'));
  await writeFile(path.join(dir, 'master.key'), generateMasterKey());
  api = await createApiApp(
    {
      DATABASE_URL: t.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
      API_PORT: '0',
      RATE_LIMIT_BURST: '5000',
      RATE_LIMIT_RPS: '5000',
      STORAGE_DIR: path.join(dir, 'storage'),
      QOS_MASTER_KEY_FILE: path.join(dir, 'master.key'),
      QOS_DEMO_MODE: 'true',
      ...AUTH_ENV,
      WEBHOOK_PORT: '0',
    },
    { logDestination: { write: (line: string) => void logs.push(line) } },
  );
  base = await api.listen();
  admin = await setupAndSignIn(base);
  const res = await admin.fetch(
    `${base}/api/v1/connections`,
    send('POST', {
      providerType: 'mock_repository',
      displayName: 'Hook repo',
      authStrategy: 'pat',
      credential: 'mock-token',
    }),
  );
  connectionId = ((await res.json()) as { id: string }).id;
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('webhook endpoint management', () => {
  it('creates an endpoint and shows its path and secret only once', async () => {
    expect((await admin.fetch(`${base}/api/v1/connections/${connectionId}/webhook`)).status).toBe(404);
    const res = await admin.fetch(`${base}/api/v1/connections/${connectionId}/webhook`, send('POST'));
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const created = (await res.json()) as { path: string; signingSecret: string; verification: string };
    expect(created.verification).toBe('hmac_sha256');
    expect(created.path).toMatch(new RegExp(`^/webhooks/${connectionId}/[A-Za-z0-9_-]{32}$`));
    hookPath = created.path;
    secret = created.signingSecret;
    const later = await (await admin.fetch(`${base}/api/v1/connections/${connectionId}/webhook`)).text();
    expect(later).not.toContain(secret);
    expect(later).not.toContain(hookPath.split('/').at(-1)!);
    const stored = JSON.stringify((await t.pool.query('select * from integrations.webhook_endpoints')).rows);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(hookPath.split('/').at(-1)!);
  });

  it('is not reachable on the API port, and the listener has no API routes', async () => {
    expect(listRoutes(api.app).some((r) => r.path.startsWith('/webhooks'))).toBe(false);
    expect((await fetch(`${base}${hookPath}`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${api.webhookUrl}/api/v1/me`)).status).toBe(404);
    expect((await fetch(`${api.webhookUrl}/healthz`)).status).toBe(404);
  });
});

describe('webhook ingress', () => {
  it('stores a verified delivery once; the redelivery is recorded as duplicate (M03-AC-02)', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc' });
    const first = await deliver(body, signed(body, 'delivery-1'));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: 'accepted' });
    const again = await deliver(body, signed(body, 'delivery-1'));
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: 'duplicate' });
    const rows = await inbox();
    expect(rows.map((r) => r.status)).toEqual(['pending', 'duplicate']);
    expect(rows[0]!.body_ref).toMatch(/^webhooks\/.+\.json$/);
    const stored = await api.storage.get(rows[0]!.body_ref!);
    expect(new TextDecoder().decode(stored)).toBe(body);
  });

  it('rejects bad signatures, unknown tokens and unknown connections without telling them apart', async () => {
    const body = '{"x":1}';
    const bad = await deliver(body, signed(body, 'delivery-2', 'wrong-secret'));
    expect(bad.status).toBe(401);
    const unsigned = await deliver(body, { 'x-mock-delivery': 'delivery-3' });
    expect(unsigned.status).toBe(401);
    const wrongToken = hookPath.replace(/[^/]+$/, 'A'.repeat(32));
    const otherConn = hookPath.replace(connectionId, '0190a5e0-7c1a-7000-8000-000000000001');
    for (const p of [wrongToken, otherConn, '/webhooks/x/y', '/elsewhere']) {
      const res = await deliver(body, signed(body, 'delivery-4'), p);
      expect(res.status, p).toBe(404);
      expect(await res.json()).toEqual({ code: 'http.404' });
    }
    const rejected = (await inbox()).filter((r) => r.verification === 'rejected');
    expect(rejected.map((r) => r.error).sort()).toEqual(['signature_mismatch', 'signature_missing']);
    expect(rejected.every((r) => r.body_ref === null)).toBe(true);
  });

  it('rejects oversized bodies with 413', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) });
    const res = await deliver(big, signed(big, 'delivery-big'));
    expect(res.status).toBe(413);
  });

  it('without a delivery id, an identical payload is deduplicated by hash', async () => {
    const body = '{"no":"id"}';
    const headers = signed(body, '');
    delete (headers as Record<string, string>)['x-mock-delivery'];
    expect(await (await deliver(body, headers)).json()).toEqual({ status: 'accepted' });
    expect(await (await deliver(body, headers)).json()).toEqual({ status: 'duplicate' });
  });

  it('rotation invalidates the old path and secret', async () => {
    const res = await admin.fetch(`${base}/api/v1/connections/${connectionId}/webhook`, send('POST'));
    const rotated = (await res.json()) as { path: string; signingSecret: string };
    const body = '{"after":"rotation"}';
    expect((await deliver(body, signed(body, 'delivery-5'))).status).toBe(404); // old path
    expect(
      (await deliver(body, signed(body, 'delivery-5', rotated.signingSecret), rotated.path)).status,
    ).toBe(202);
    expect((await deliver(body, signed(body, 'delivery-6', secret), rotated.path)).status).toBe(401); // old secret
    secret = rotated.signingSecret;
    hookPath = rotated.path;
  });

  it('a retired connection no longer accepts deliveries', async () => {
    await admin.fetch(`${base}/api/v1/connections/${connectionId}/retire`, send('POST'));
    const body = '{"after":"retire"}';
    expect((await deliver(body, signed(body, 'delivery-7'))).status).toBe(404);
  });

  it('never logs the signing secret or the path token', () => {
    const all = logs.join('');
    expect(all).not.toContain(secret);
    expect(all).not.toContain(hookPath.split('/').at(-1)!);
  });
});
