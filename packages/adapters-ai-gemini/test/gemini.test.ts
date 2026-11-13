import { SafeHttpClient } from '@qos/kernel-infra';
import { spyContext } from '@qos/contract-tests';
import type { OutboundHttp } from '@qos/ports';
import { describe, expect, it } from 'vitest';
import { GeminiConnection } from '../src/index.js';

/** Fixture shaped after the Gemini API `models.list` response; synthetic data. */
const KEY = 'fixture-gemini-key-not-real';
function fixture(over?: { status: number; body?: string; headers?: Record<string, string> }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const http: OutboundHttp = {
    request: async (url, req = {}) => {
      calls.push({ url, headers: { ...(req.headers ?? {}) } });
      const r =
        over ??
        (req.headers?.['x-goog-api-key'] === KEY
          ? {
              status: 200,
              body: JSON.stringify({
                models: [
                  {
                    name: 'models/gemini-3.5-flash',
                    supportedGenerationMethods: ['generateContent', 'countTokens'],
                  },
                  { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
                ],
              }),
            }
          : {
              status: 400,
              body: JSON.stringify({
                error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] },
              }),
            });
      return {
        status: r.status,
        headers: r.headers ?? {},
        body: new TextEncoder().encode(r.body ?? ''),
        url,
      };
    },
  };
  return { http, calls };
}
const adapter = new GeminiConnection();

describe('Gemini connection test (T-P2-29)', () => {
  it('lists generative models with the key in a header, never in the URL', async () => {
    const f = fixture();
    const r = await adapter.testConnection(spyContext(KEY, undefined, f.http).ctx);
    expect(r).toMatchObject({
      identity: 'API key (1 generative models)',
      scopesDiscovered: ['gemini-3.5-flash'],
    });
    expect(r.permissionChecks.every((c) => c.ok)).toBe(true);
    expect(f.calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100');
    expect(f.calls[0]!.url).not.toContain(KEY);
  });

  it('maps an invalid key, quota and outages', async () => {
    await expect(
      adapter.testConnection(spyContext('wrong', undefined, fixture().http).ctx),
    ).rejects.toMatchObject({ kind: 'auth_failed' });
    await expect(
      adapter.testConnection(
        spyContext(KEY, undefined, fixture({ status: 429, headers: { 'retry-after': '30' } }).http).ctx,
      ),
    ).rejects.toMatchObject({ kind: 'rate_limited', details: { retryAfterMs: 30_000 } });
    await expect(
      adapter.testConnection(spyContext(KEY, undefined, fixture({ status: 503 }).http).ctx),
    ).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  // Live check against the real API, only when the owner's key is in the environment.
  const live = process.env.GEMINI_API_KEY;
  it.skipIf(!live)(
    `live: the configured key lists models${live ? '' : ' [skipped: GEMINI_API_KEY not set]'}`,
    async () => {
      const r = await adapter.testConnection(
        spyContext(live!, undefined, new SafeHttpClient({ timeoutMs: 20_000 })).ctx,
      );
      expect(r.permissionChecks.every((c) => c.ok)).toBe(true);
    },
    30_000,
  );
});
