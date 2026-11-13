import { spyContext } from '@qos/contract-tests';
import type { OutboundHttp } from '@qos/ports';
import { describe, expect, it } from 'vitest';
import { AzureDevOpsConnection, parseOrganization } from '../src/index.js';

/**
 * Fixture responses written from the Azure DevOps REST API documentation (Projects - List,
 * api-version 7.1). Synthetic data, not captured from a live organization.
 */
const PAT = 'fixture-pat-not-a-real-credential';
function fixture(over?: { status: number; headers?: Record<string, string>; body?: string }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const http: OutboundHttp = {
    request: async (url, req = {}) => {
      calls.push({ url, headers: { ...(req.headers ?? {}) } });
      const auth = req.headers?.authorization;
      const ok = auth === `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`;
      const r =
        over ??
        (ok
          ? {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                count: 2,
                value: [
                  { id: 'a', name: 'Payments' },
                  { id: 'b', name: 'Mobile' },
                ],
              }),
            }
          : { status: 401, headers: { 'content-type': 'text/plain' }, body: '' });
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
const ctx = (http: OutboundHttp, secret = PAT, baseUrl = 'https://dev.azure.com/contoso-qa') =>
  spyContext(secret, baseUrl, http).ctx;
const adapter = new AzureDevOpsConnection();

describe('Azure DevOps PAT connection (T-P2-28)', () => {
  it('reads the organization with Basic auth and an explicit api-version', async () => {
    const f = fixture();
    const r = await adapter.testConnection(ctx(f.http));
    expect(r).toMatchObject({ identity: 'organization contoso-qa', permissionChecks: [] });
    expect(f.calls[0]!.url).toBe('https://dev.azure.com/contoso-qa/_apis/projects?api-version=7.1&$top=100');
    expect(f.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`:${PAT}`).toString('base64')}`);
    expect(f.calls[0]!.url).not.toContain(PAT);
  });

  it('accepts only an organization URL', () => {
    expect(parseOrganization('https://dev.azure.com/contoso-qa/')).toBe('contoso-qa');
    for (const bad of [
      null,
      '',
      'http://dev.azure.com/x',
      'https://dev.azure.com',
      'https://dev.azure.com/a/b',
      'https://evil.example/contoso',
    ]) {
      expect(() => parseOrganization(bad), String(bad)).toThrow(/base URL must be/);
    }
  });

  it('maps failures, including the 203 sign-in page an invalid PAT can get', async () => {
    await expect(adapter.testConnection(ctx(fixture().http, 'wrong-pat'))).rejects.toMatchObject({
      kind: 'auth_failed',
    });
    const signIn = fixture({
      status: 203,
      headers: { 'content-type': 'text/html' },
      body: '<html>Sign in</html>',
    });
    await expect(adapter.testConnection(ctx(signIn.http))).rejects.toMatchObject({ kind: 'auth_failed' });
    await expect(adapter.testConnection(ctx(fixture({ status: 403 }).http))).rejects.toMatchObject({
      kind: 'permission_denied',
    });
    await expect(adapter.testConnection(ctx(fixture({ status: 404 }).http))).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(
      adapter.testConnection(ctx(fixture({ status: 429, headers: { 'retry-after': '7' } }).http)),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
      details: { retryAfterMs: 7000 },
    });
    await expect(adapter.testConnection(ctx(fixture({ status: 503 }).http))).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('declares no work-item capabilities yet, so it cannot be bound before P3/P8', () => {
    expect(adapter.manifest()).toMatchObject({
      providerType: 'azure_devops',
      capabilities: [],
      authStrategies: ['pat'],
    });
  });
});
