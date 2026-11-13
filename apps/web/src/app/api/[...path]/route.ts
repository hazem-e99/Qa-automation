import type { NextRequest } from 'next/server';
import { apiBaseUrl } from '@/lib/server-api';

/**
 * Backend-for-frontend proxy (doc 20): the browser talks only to the web origin, which forwards
 * `/api/v1/*` to the API. The session cookie therefore stays first-party, and the API address is
 * never exposed to the browser. Only the headers the API needs are forwarded, in both directions.
 */
const REQUEST_HEADERS = [
  'accept',
  'content-type',
  'cookie',
  'x-csrf-token',
  'x-setup-token',
  'idempotency-key',
  'user-agent',
  'last-event-id',
];
const RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'retry-after',
  'x-correlation-id',
  'idempotent-replayed',
];

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  if (path[0] !== 'v1' || path.some((p) => p === '..' || p.includes('\\'))) {
    return Response.json({ code: 'http.404', params: {}, correlationId: null }, { status: 404 });
  }
  const target = `${apiBaseUrl()}/api/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const headers = new Headers();
  for (const h of REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  // The API trusts this header only from the configured proxy addresses (TRUST_PROXY).
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) headers.set('x-forwarded-for', forwarded);
  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return Response.json({ code: 'api.unreachable', params: {}, correlationId: null }, { status: 502 });
  }
  const out = new Headers();
  for (const h of RESPONSE_HEADERS) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
  return new Response(res.body, { status: res.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const dynamic = 'force-dynamic';
