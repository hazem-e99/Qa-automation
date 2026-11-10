import { createServer, type Server } from 'node:http';
import type { HealthResponse } from '@qos/contracts';

export type HealthCheck = () => Promise<void>;

export interface HealthOptions {
  readonly service: string;
  readonly version: string;
  readonly checks: Readonly<Record<string, HealthCheck>>;
  readonly timeoutMs?: number;
}

/** Runs every readiness check with a timeout. Details stay generic so they leak nothing. */
export async function evaluateReadiness(opts: HealthOptions): Promise<HealthResponse> {
  const entries = await Promise.all(
    Object.entries(opts.checks).map(async ([name, check]) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          check(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), opts.timeoutMs ?? 3_000);
          }),
        ]);
        return [name, { status: 'ok' as const }] as const;
      } catch (e) {
        const detail = e instanceof Error && e.message === 'timeout' ? 'timeout' : 'unavailable';
        return [name, { status: 'fail' as const, detail }] as const;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const checks = Object.fromEntries(entries);
  const status = entries.every(([, c]) => c.status === 'ok') ? 'ok' : 'fail';
  return { service: opts.service, status, version: opts.version, checks };
}

export const liveness = (opts: Pick<HealthOptions, 'service' | 'version'>): HealthResponse => ({
  service: opts.service,
  status: 'ok',
  version: opts.version,
  checks: {},
});

/** Minimal health endpoint for processes without an HTTP API (worker, execution controller). */
export function startHealthServer(port: number, opts: HealthOptions, host = '0.0.0.0'): Promise<Server> {
  const server = createServer((req, res) => {
    const send = (code: number, body: HealthResponse) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/healthz') return send(200, liveness(opts));
    if (req.method === 'GET' && req.url === '/readyz') {
      void evaluateReadiness(opts).then((r) => send(r.status === 'ok' ? 200 : 503, r));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

export const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
