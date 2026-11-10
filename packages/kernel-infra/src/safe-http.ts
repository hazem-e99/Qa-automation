import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, request } from 'undici';
import { TokenBucketLimiter } from './rate-limit.js';

/**
 * SafeHttpClient (T-P1-17): the only way adapters make outbound HTTP calls.
 * Defends against SSRF: only http/https, no credentials in URLs, every resolved address must be
 * public (unless the host is explicitly allow-listed), the connection is pinned to the address
 * that was checked (no DNS rebinding between check and connect), and every redirect hop is
 * validated again.
 */
export class SsrfError extends Error {
  constructor(
    readonly reason: string,
    readonly host: string,
  ) {
    super(`blocked outbound request (${reason})`);
    this.name = 'SsrfError';
  }
}
export class HttpLimitError extends Error {
  constructor(readonly reason: 'timeout' | 'too_large' | 'too_many_redirects') {
    super(`outbound request failed (${reason})`);
    this.name = 'HttpLimitError';
  }
}

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

/** True only for addresses that are routable on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !blocked.check(address, 'ipv6');
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

export interface SafeHttpClientOptions {
  /** Hostnames (exact, lower case) that may resolve to private addresses, e.g. a local orchestrator. */
  readonly allowPrivateHosts?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxResponseBytes?: number;
  /** Retries for idempotent methods on network errors and 502/503/504. */
  readonly retries?: number;
  /** Outbound rate limit of this client (one client per connection). */
  readonly rateLimit?: { readonly ratePerSecond: number; readonly burst: number };
  readonly resolver?: Resolver;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SafeRequest {
  readonly method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface SafeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** Final URL after redirects. */
  readonly url: string;
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
const RETRY_STATUS = new Set([502, 503, 504]);
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key']);

export class SafeHttpClient {
  private readonly allow: ReadonlySet<string>;
  private readonly limiter: TokenBucketLimiter | null;
  private readonly resolver: Resolver;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: SafeHttpClientOptions = {}) {
    this.allow = new Set((opts.allowPrivateHosts ?? []).map((h) => h.toLowerCase()));
    this.limiter = opts.rateLimit ? new TokenBucketLimiter(opts.rateLimit) : null;
    this.resolver = opts.resolver ?? systemResolver;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request(url: string, req: SafeRequest = {}): Promise<SafeResponse> {
    const method = req.method ?? 'GET';
    const attempts = IDEMPOTENT.has(method) ? (this.opts.retries ?? 2) + 1 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.follow(url, method, req);
        if (!RETRY_STATUS.has(res.status) || attempt >= attempts) return res;
        const retryAfter = Number(res.headers['retry-after']);
        await this.sleep(Math.min(30_000, retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt));
      } catch (e) {
        // Policy and limit errors are final. Only transport errors are retried.
        if (e instanceof SsrfError || e instanceof HttpLimitError || attempt >= attempts) throw e;
        await this.sleep(250 * 2 ** attempt);
      }
    }
  }

  private async follow(startUrl: string, startMethod: string, req: SafeRequest): Promise<SafeResponse> {
    let url = startUrl;
    let method = startMethod;
    let body = req.body;
    let headers: Record<string, string> = { ...req.headers };
    const maxRedirects = this.opts.maxRedirects ?? 5;
    for (let hop = 0; ; hop++) {
      const target = await this.vet(url);
      await this.throttle();
      const res = await this.send(target, method, headers, body);
      const location = res.headers['location'];
      if (res.status < 300 || res.status >= 400 || !location) return { ...res, url: target.url.href };
      if (hop >= maxRedirects) throw new HttpLimitError('too_many_redirects');
      const next = new URL(location, target.url);
      if (next.host !== target.url.host) {
        // Never forward credentials to another host.
        headers = Object.fromEntries(
          Object.entries(headers).filter(([k]) => !SENSITIVE_HEADERS.has(k.toLowerCase())),
        );
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      url = next.href;
    }
  }

  /** Validates one hop and returns the address the connection will be pinned to. */
  private async vet(rawUrl: string): Promise<{ url: URL; pinned: ResolvedAddress }> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new SsrfError('invalid_url', '');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new SsrfError('scheme_not_allowed', host);
    if (url.username || url.password) throw new SsrfError('credentials_in_url', host);
    const allowPrivate = this.allow.has(host);
    const literal = isIP(host);
    let addresses: readonly ResolvedAddress[];
    if (literal) {
      addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
    } else {
      try {
        addresses = await this.resolver(host);
      } catch {
        throw new SsrfError('dns_failed', host);
      }
    }
    if (addresses.length === 0) throw new SsrfError('dns_failed', host);
    // Every answer must be acceptable: one private record among public ones is a rebinding setup.
    if (!allowPrivate && !addresses.every((a) => isPublicAddress(a.address))) {
      throw new SsrfError('private_address', host);
    }
    return { url, pinned: addresses[0]! };
  }

  private async throttle(): Promise<void> {
    if (!this.limiter) return;
    for (;;) {
      const d = this.limiter.take('outbound');
      if (d.allowed) return;
      await this.sleep(d.retryAfterSeconds * 1000);
    }
  }

  private async send(
    target: { url: URL; pinned: ResolvedAddress },
    method: string,
    headers: Record<string, string>,
    body: string | Uint8Array | undefined,
  ): Promise<Omit<SafeResponse, 'url'>> {
    const timeoutMs = this.opts.timeoutMs ?? 15_000;
    const maxBytes = this.opts.maxResponseBytes ?? 10 * 1024 * 1024;
    const { pinned } = target;
    // The agent connects to the vetted address only; the Host header and TLS name stay the hostname.
    const agent = new Agent({
      connect: {
        timeout: timeoutMs,
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) {
            (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
          } else {
            (callback as (e: null, a: string, f: number) => void)(null, pinned.address, pinned.family);
          }
        },
      },
      pipelining: 0,
    });
    try {
      const res = await request(target.url, {
        method,
        headers,
        body: body ?? null,
        dispatcher: agent,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
          res.body.destroy();
          throw new HttpLimitError('too_large');
        }
        chunks.push(chunk as Buffer);
      }
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      }
      return { status: res.statusCode, headers: flat, body: new Uint8Array(Buffer.concat(chunks)) };
    } catch (e) {
      const name = (e as { name?: string; code?: string } | null)?.name;
      const code = (e as { code?: string } | null)?.code ?? '';
      if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT/.test(code))
        throw new HttpLimitError('timeout');
      throw e;
    } finally {
      await agent.close().catch(() => undefined);
    }
  }
}
