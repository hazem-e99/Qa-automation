import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, HealthResponse, ProbeResponse } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
// Boot tests run against the compiled output, exactly what `node dist/main.js` runs.
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';

let t: TestDatabase;
let api: ApiApp;
let base: string;

beforeAll(async () => {
  t = await startTestDatabase();
  api = await createApiApp({ DATABASE_URL: t.url, NODE_ENV: 'test', LOG_LEVEL: 'silent', API_PORT: '39001' });
  base = await api.listen();
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/platform/probes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const counts = async () =>
  (
    await t.pool.query(
      `select (select count(*)::int from platform.probes) probes,
              (select count(*)::int from governance.audit_events) audit,
              (select count(*)::int from platform.outbox_events) outbox,
              (select count(*)::int from pgboss.job where name = 'platform.probe.process') jobs`,
    )
  ).rows[0] as { probes: number; audit: number; outbox: number; jobs: number };

describe('api boot', () => {
  it('rejects an invalid configuration without printing values', async () => {
    await expect(createApiApp({ DATABASE_URL: 'mysql://u:topsecret@h/d' })).rejects.toThrow(/DATABASE_URL/);
    await expect(createApiApp({ DATABASE_URL: 'mysql://u:topsecret@h/d' })).rejects.not.toThrow(/topsecret/);
  });

  it('serves /healthz and /readyz with the health contract', async () => {
    const live = await fetch(`${base}/healthz`);
    expect(live.status).toBe(200);
    expect(HealthResponse.parse(await live.json())).toMatchObject({ service: 'api', status: 'ok' });
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(HealthResponse.parse(await ready.json()).checks).toEqual({
      db: { status: 'ok' },
      jobs: { status: 'ok' },
    });
  });
});

describe('probe command over HTTP', () => {
  it('creates a probe atomically and propagates the correlation id', async () => {
    const before = await counts();
    const res = await post({ label: 'http' }, { 'x-correlation-id': 'corr-http-00001' });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-correlation-id')).toBe('corr-http-00001');
    const body = ProbeResponse.parse(await res.json());
    const after = await counts();
    expect(after).toEqual({
      probes: before.probes + 1,
      audit: before.audit + 1,
      outbox: before.outbox + 1,
      jobs: before.jobs + 1,
    });
    const ev = await t.pool.query(
      'select correlation_id from platform.outbox_events where aggregate_id = $1',
      [body.id],
    );
    expect(ev.rows[0].correlation_id).toBe('corr-http-00001');
    const job = await t.pool.query(
      "select data->>'correlationId' c from pgboss.job where name = 'platform.probe.process' and data->'data'->>'probeId' = $1",
      [body.id],
    );
    expect(job.rows[0].c).toBe('corr-http-00001');
    const got = await fetch(`${base}/api/v1/platform/probes/${body.id}`);
    expect(ProbeResponse.parse(await got.json()).label).toBe('http');
  });

  it('a forced failure returns 422 and leaves nothing behind', async () => {
    const before = await counts();
    const res = await post({ label: 'boom', failAfterWrites: true });
    expect(res.status).toBe(422);
    expect(ApiError.parse(await res.json()).code).toBe('probe.forced_failure');
    expect(await counts()).toEqual(before);
  });

  it('answers invalid input with the error envelope and no internals', async () => {
    const invalid = await post({ label: '' });
    expect(invalid.status).toBe(400);
    const body = ApiError.parse(await invalid.json());
    expect(body).toMatchObject({ code: 'request.invalid', params: { fields: 'label' } });
    expect(body.correlationId).toBeTruthy();

    const badJson = await post('{not json');
    expect(badJson.status).toBe(400);
    expect(JSON.stringify(await badJson.json())).not.toMatch(/stack|at .*\.js|SyntaxError/);

    const notUuid = await fetch(`${base}/api/v1/platform/probes/not-a-uuid`);
    expect(notUuid.status).toBe(400);
    const missing = await fetch(`${base}/api/v1/platform/probes/0190a5e0-7c1a-7000-8000-000000000001`);
    expect(missing.status).toBe(404);
    expect(ApiError.parse(await missing.json()).code).toBe('http.404');
  });

  it('replaces an unsafe correlation id supplied by the caller', async () => {
    const res = await post({ label: 'corr' }, { 'x-correlation-id': 'bad id {"x":1}' });
    const id = res.headers.get('x-correlation-id');
    expect(id).not.toBe('bad id {"x":1}');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('graceful shutdown', () => {
  it('closes the server and the pool; a second close is a no-op', async () => {
    const other = await createApiApp({
      DATABASE_URL: t.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      API_PORT: '39002',
    });
    const url = await other.listen();
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    await other.close();
    await other.close();
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    expect(other.infra.pool.ended).toBe(true);
  });
});
