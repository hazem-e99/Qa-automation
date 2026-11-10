import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpLimitError, isPublicAddress, SafeHttpClient, SsrfError, type Resolver } from './safe-http.js';

describe('isPublicAddress', () => {
  it('rejects loopback, private, link-local, metadata, CGNAT, multicast and reserved ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
  it('accepts public addresses and rejects non-addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    expect(isPublicAddress('example.com')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});

describe('SafeHttpClient', () => {
  let server: Server;
  let port: number;
  let hits: { url: string; headers: IncomingMessage['headers'] }[] = [];
  let flaky = 0;
  const instant = async () => {};

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      hits.push({ url: req.url ?? '', headers: req.headers });
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/ok') return void res.end('hello');
      if (u.pathname === '/redirect') {
        return void res.writeHead(302, { location: u.searchParams.get('to') ?? '/ok' }).end();
      }
      if (u.pathname === '/loop') return void res.writeHead(302, { location: '/loop' }).end();
      if (u.pathname === '/slow') return void setTimeout(() => res.end('late'), 2_000);
      if (u.pathname === '/big') return void res.end('x'.repeat(5_000));
      if (u.pathname === '/flaky') {
        flaky++;
        return void res.writeHead(flaky < 3 ? 503 : 200).end(flaky < 3 ? 'busy' : 'recovered');
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const local = (extra = {}) =>
    new SafeHttpClient({ allowPrivateHosts: ['127.0.0.1'], sleep: instant, ...extra });
  const blocked = async (client: SafeHttpClient, url: string, reason: string) => {
    const err = await client.request(url).catch((e: unknown) => e);
    expect(err, url).toBeInstanceOf(SsrfError);
    expect((err as SsrfError).reason).toBe(reason);
  };

  it('blocks private and metadata targets by default, before any connection is made', async () => {
    hits = [];
    const client = new SafeHttpClient();
    await blocked(client, `http://127.0.0.1:${port}/ok`, 'private_address');
    await blocked(client, 'http://169.254.169.254/latest/meta-data/', 'private_address');
    await blocked(client, 'http://[::1]/', 'private_address');
    await blocked(client, 'http://10.0.0.5/', 'private_address');
    expect(hits).toHaveLength(0);
  });

  it('blocks non-http schemes, credentials in URLs and unparsable URLs', async () => {
    const client = local();
    await blocked(client, 'file:///etc/passwd', 'scheme_not_allowed');
    await blocked(client, 'gopher://127.0.0.1/', 'scheme_not_allowed');
    await blocked(client, `http://user:pw@127.0.0.1:${port}/ok`, 'credentials_in_url');
    await blocked(client, 'not a url', 'invalid_url');
  });

  it('blocks a hostname that resolves to a private address, even next to a public one', async () => {
    const resolver: Resolver = async (h) =>
      h === 'mixed.test'
        ? [
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ]
        : [{ address: '10.0.0.9', family: 4 }];
    const client = new SafeHttpClient({ resolver });
    await blocked(client, 'http://internal.test/', 'private_address');
    await blocked(client, 'http://mixed.test/', 'private_address');
  });

  it('pins the connection to the vetted address (the name is resolved once, by us)', async () => {
    let lookups = 0;
    const resolver: Resolver = async () => {
      lookups++;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    // "pinned.test" does not exist in real DNS: the request can only succeed through the pinned address.
    const client = new SafeHttpClient({ resolver, allowPrivateHosts: ['pinned.test'] });
    const res = await client.request(`http://pinned.test:${port}/ok`);
    expect(new TextDecoder().decode(res.body)).toBe('hello');
    expect(lookups).toBe(1);
    expect(hits.at(-1)?.headers.host).toBe(`pinned.test:${port}`);
  });

  it('re-validates redirects: an allowed host cannot bounce the client to a blocked one', async () => {
    const client = local();
    const ok = await client.request(`http://127.0.0.1:${port}/redirect?to=/ok`);
    expect(ok.status).toBe(200);
    expect(ok.url).toBe(`http://127.0.0.1:${port}/ok`);
    for (const to of ['http://169.254.169.254/', 'http://localhost:1/', 'file:///etc/passwd']) {
      const err = await client
        .request(`http://127.0.0.1:${port}/redirect?to=${encodeURIComponent(to)}`)
        .catch((e: unknown) => e);
      expect(err, to).toBeInstanceOf(SsrfError);
    }
    await expect(client.request(`http://127.0.0.1:${port}/loop`)).rejects.toMatchObject({
      reason: 'too_many_redirects',
    });
  });

  it('drops credentials when a redirect changes host', async () => {
    const resolver: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    const client = new SafeHttpClient({ resolver, allowPrivateHosts: ['a.test', 'b.test'], sleep: instant });
    hits = [];
    await client.request(
      `http://a.test:${port}/redirect?to=${encodeURIComponent(`http://b.test:${port}/ok`)}`,
      {
        headers: { authorization: 'Bearer secret', 'x-trace': 'keep' },
      },
    );
    expect(hits[0]?.headers.authorization).toBe('Bearer secret');
    expect(hits[1]?.headers.authorization).toBeUndefined();
    expect(hits[1]?.headers['x-trace']).toBe('keep');
  });

  it('enforces the timeout and the response size cap', async () => {
    await expect(
      local({ timeoutMs: 200, retries: 0 }).request(`http://127.0.0.1:${port}/slow`),
    ).rejects.toMatchObject({
      reason: 'timeout',
    });
    const err = await local({ maxResponseBytes: 1_000 })
      .request(`http://127.0.0.1:${port}/big`)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpLimitError);
    expect((err as HttpLimitError).reason).toBe('too_large');
  });

  it('retries idempotent requests on 503 and never retries POST', async () => {
    flaky = 0;
    const res = await local({ retries: 3 }).request(`http://127.0.0.1:${port}/flaky`);
    expect(res.status).toBe(200);
    expect(flaky).toBe(3);
    flaky = 0;
    const post = await local({ retries: 3 }).request(`http://127.0.0.1:${port}/flaky`, {
      method: 'POST',
      body: '{}',
    });
    expect(post.status).toBe(503);
    expect(flaky).toBe(1);
  });

  it('spaces requests according to the per-connection rate limit', async () => {
    const waits: number[] = [];
    const client = local({
      rateLimit: { ratePerSecond: 1, burst: 2 },
      sleep: async (ms: number) => {
        waits.push(ms);
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    for (let i = 0; i < 3; i++) await client.request(`http://127.0.0.1:${port}/ok`);
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits[0]).toBe(1000);
  }, 15_000);
});
