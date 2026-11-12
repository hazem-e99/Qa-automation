import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, OperationResponse, ProbeResponse } from '@qos/contracts';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { processProbeJob } from '@qos/probe';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';
import { AUTH_ENV, setupAndSignIn, type Session } from './helpers.js';

let t: TestDatabase;
let api: ApiApp;
let base: string;
let s: Session;
const env = (extra: Record<string, string>) => ({
  DATABASE_URL: t.url,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ...AUTH_ENV,
  ...extra,
});

beforeAll(async () => {
  t = await startTestDatabase();
  api = await createApiApp(env({ API_PORT: '0', RATE_LIMIT_BURST: '1000', RATE_LIMIT_RPS: '1000' }));
  base = await api.listen();
  s = await setupAndSignIn(base);
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  s.fetch(`${base}/api/v1/platform/probes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const probeCount = async () =>
  (await t.pool.query('select count(*)::int c from platform.probes')).rows[0].c as number;
/** Stands in for the worker: handles the probe job the way the real handler does. */
const runJob = (probeId: string) =>
  processProbeJob(t.db, {
    id: 'test',
    queue: 'platform.probe.process',
    data: { probeId },
    correlationId: null,
  });

describe('Idempotency-Key over HTTP', () => {
  it('a repeated key returns the first response and runs the command once', async () => {
    const before = await probeCount();
    const headers = { 'idempotency-key': 'http-key-00000001' };
    const first = await post({ label: 'idem' }, headers);
    const second = await post({ label: 'idem' }, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    const a = ProbeResponse.parse(await first.json());
    const b = ProbeResponse.parse(await second.json());
    expect(b).toEqual(a);
    expect(await probeCount()).toBe(before + 1);
  });

  it('the same key with another body is refused (422), a malformed key is a 400', async () => {
    const headers = { 'idempotency-key': 'http-key-00000002' };
    expect((await post({ label: 'one' }, headers)).status).toBe(201);
    const reused = await post({ label: 'two' }, headers);
    expect(reused.status).toBe(422);
    expect(ApiError.parse(await reused.json()).code).toBe('idempotency.key_reused');
    const bad = await post({ label: 'x' }, { 'idempotency-key': 'no' });
    expect(bad.status).toBe(400);
    expect(ApiError.parse(await bad.json()).code).toBe('idempotency.key_invalid');
  });

  it('a failed command stores nothing, so the same key works on retry', async () => {
    const before = await probeCount();
    const headers = { 'idempotency-key': 'http-key-00000003' };
    expect((await post({ label: 'retry', failAfterWrites: true }, headers)).status).toBe(422);
    expect(await probeCount()).toBe(before);
    const keys = await t.pool.query(
      "select count(*)::int c from platform.idempotency_keys where key = 'http-key-00000003'",
    );
    expect(keys.rows[0].c).toBe(0);
  });

  it('concurrent requests with one key create one probe', async () => {
    const before = await probeCount();
    const headers = { 'idempotency-key': 'http-key-00000004' };
    const responses = await Promise.all(Array.from({ length: 6 }, () => post({ label: 'race' }, headers)));
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));
    const ids = new Set(
      await Promise.all(responses.map(async (r) => ProbeResponse.parse(await r.json()).id)),
    );
    expect(ids.size).toBe(1);
    expect(await probeCount()).toBe(before + 1);
  });
});

describe('operations', () => {
  it('returns the operation as JSON and 404/400 for unknown or malformed ids', async () => {
    const probe = ProbeResponse.parse(await (await post({ label: 'op' })).json());
    const res = await s.fetch(`${base}/api/v1/operations/${probe.operationId}`);
    expect(OperationResponse.parse(await res.json())).toMatchObject({
      status: 'queued',
      type: 'platform.probe',
    });
    expect((await s.fetch(`${base}/api/v1/operations/0190a5e0-7c1a-7000-8000-000000000001`)).status).toBe(
      404,
    );
    expect((await s.fetch(`${base}/api/v1/operations/nope/events`)).status).toBe(400);
  });

  it('streams state changes over SSE and closes on the final status', async () => {
    const probe = ProbeResponse.parse(await (await post({ label: 'sse' })).json());
    const res = await s.fetch(`${base}/api/v1/operations/${probe.operationId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const statuses = () =>
      [...text.matchAll(/^data: (.+)$/gm)].map((m) => OperationResponse.parse(JSON.parse(m[1]!)).status);
    const readUntil = async (pred: () => boolean) => {
      while (!pred()) {
        const { done, value } = await reader.read();
        if (done) return true;
        text += decoder.decode(value, { stream: true });
      }
      return false;
    };
    await readUntil(() => statuses().length >= 1);
    expect(statuses()[0]).toBe('queued');
    await runJob(probe.id);
    const ended = await readUntil(() => false); // read until the server closes the stream
    expect(ended).toBe(true);
    expect(statuses().at(-1)).toBe('succeeded');
    expect(statuses()).toContain('queued');
  });

  it('a stream opened after completion sends the final state once and closes', async () => {
    const probe = ProbeResponse.parse(await (await post({ label: 'late' })).json());
    await runJob(probe.id);
    const res = await s.fetch(`${base}/api/v1/operations/${probe.operationId}/events`);
    const body = await res.text();
    expect(body.match(/^event: operation$/gm)).toHaveLength(1);
    expect(body).toContain('"status":"succeeded"');
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the burst is used; health is exempt', async () => {
    const limited = await createApiApp(env({ API_PORT: '0', RATE_LIMIT_BURST: '3', RATE_LIMIT_RPS: '0.5' }));
    const url = await limited.listen();
    try {
      const probe = '/api/v1/operations/0190a5e0-7c1a-7000-8000-000000000001';
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await fetch(url + probe)).status);
      // The limit applies before authentication: unauthenticated callers are throttled too.
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
      const refused = await fetch(url + probe);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      const body = ApiError.parse(await refused.json());
      expect(body.code).toBe('rate_limited');
      expect(body.correlationId).toBeTruthy();
      for (let i = 0; i < 10; i++) expect((await fetch(`${url}/readyz`)).status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
