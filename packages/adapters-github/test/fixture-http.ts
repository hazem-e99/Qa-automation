import type { OutboundHttp } from '@qos/ports';

/**
 * Fixture GitHub API for contract tests ("recorded" mode).
 *
 * These responses are hand-written from GitHub's public REST API documentation (v2022-11-28):
 * same paths, status codes, headers and field names, but synthetic data. They are not captured
 * from a live account; capturing real recordings needs a token from the owner (see the status
 * file). Only the fields the adapter reads are included.
 */
export const FIXTURE_TOKEN = 'fixture-token-not-a-real-credential';
export const REPO_ID = '4242';
const FULL = 'octo-demo/sample-app';
const BASE = 'https://api.github.com';

type Response = { status: number; headers?: Record<string, string>; body?: unknown };

export class FixtureGitHub implements OutboundHttp {
  readonly calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  private faults: Response[] = [];
  private readonly refs = new Set(['main']);
  private readonly pulls: { number: number; head: string; base: string }[] = [];
  scopes: string | null = 'repo, read:org';
  tokenExpiry: string | null = '2026-12-01 00:00:00 UTC';

  private readonly commits = Array.from({ length: 120 }, (_, i) => ({
    sha: (i + 1).toString(16).padStart(40, 'a'),
    commit: {
      message: `Commit ${120 - i}`,
      author: {
        name: 'Demo Dev',
        email: 'dev@example.test',
        date: new Date(Date.UTC(2026, 9, 1, 0, 120 - i)).toISOString(),
      },
    },
    author: { login: 'demo-dev' },
  }));

  /** The next request answers with this status (e.g. 401, 403 with rate-limit headers, 500). */
  failNext(status: number, headers: Record<string, string> = {}): void {
    this.faults.push({ status, headers, body: { message: 'simulated' } });
  }

  reset(): void {
    this.faults = [];
    this.calls.length = 0;
    this.refs.clear();
    this.refs.add('main');
    this.pulls.length = 0;
  }

  async request(
    url: string,
    req: { method?: string; headers?: Readonly<Record<string, string>>; body?: string | Uint8Array } = {},
  ) {
    const method = req.method ?? 'GET';
    const headers = { ...(req.headers ?? {}) };
    this.calls.push({ method, url, headers });
    const fault = this.faults.shift();
    const r = fault ?? this.route(method, url, headers, req.body);
    const out: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      ...(r.headers ?? {}),
    };
    if (this.scopes !== null && url === `${BASE}/user`) out['x-oauth-scopes'] = this.scopes;
    if (this.tokenExpiry) out['github-authentication-token-expiration'] = this.tokenExpiry;
    return {
      status: r.status,
      headers: out,
      body: new TextEncoder().encode(r.body === undefined ? '' : JSON.stringify(r.body)),
      url,
    };
  }

  private route(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string | Uint8Array,
  ): Response {
    if (headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) {
      return { status: 401, body: { message: 'Bad credentials' } };
    }
    const u = new URL(url);
    if (u.origin !== BASE) return { status: 404, body: { message: 'Not Found' } };
    const p = u.pathname;
    const page = Number(u.searchParams.get('page') ?? '1');
    const perPage = Number(u.searchParams.get('per_page') ?? '30');
    const paged = <T>(all: T[]): Response => {
      const items = all.slice((page - 1) * perPage, page * perPage);
      const last = Math.max(1, Math.ceil(all.length / perPage));
      const link =
        page < last
          ? `<${BASE}${p}?page=${page + 1}&per_page=${perPage}>; rel="next", <${BASE}${p}?page=${last}&per_page=${perPage}>; rel="last"`
          : undefined;
      return { status: 200, body: items, ...(link ? { headers: { link } } : {}) };
    };
    const repo = {
      id: Number(REPO_ID),
      full_name: FULL,
      default_branch: 'main',
      html_url: `https://github.com/${FULL}`,
      private: true,
      visibility: 'private',
    };

    if (method === 'GET' && p === '/user') return { status: 200, body: { login: 'demo-dev', id: 1 } };
    if (method === 'GET' && p === '/user/repos')
      return paged([repo, { ...repo, id: 4343, full_name: 'octo-demo/other' }]);
    if (method === 'GET' && p === `/repositories/${REPO_ID}`) return { status: 200, body: repo };
    if (method === 'GET' && p.startsWith('/repositories/'))
      return { status: 404, body: { message: 'Not Found' } };
    if (method === 'GET' && p === `/repos/${FULL}/commits`) {
      return u.searchParams.get('sha') === 'main'
        ? paged(this.commits)
        : { status: 404, body: { message: 'No commit found for SHA' } };
    }
    if (method === 'GET' && p === `/repos/${FULL}/contents/README.md`) {
      return {
        status: 200,
        body: { type: 'file', encoding: 'base64', content: Buffer.from('# sample-app\n').toString('base64') },
      };
    }
    if (method === 'GET' && p.startsWith(`/repos/${FULL}/contents/`))
      return { status: 404, body: { message: 'Not Found' } };
    if (method === 'GET' && p === `/repos/${FULL}/git/ref/heads/main`) {
      return {
        status: 200,
        body: { ref: 'refs/heads/main', object: { sha: this.commits[0]!.sha, type: 'commit' } },
      };
    }
    if (method === 'POST' && p === `/repos/${FULL}/git/refs`) {
      const { ref } = JSON.parse(String(body)) as { ref: string };
      const name = ref.replace('refs/heads/', '');
      if (this.refs.has(name)) return { status: 422, body: { message: 'Reference already exists' } };
      this.refs.add(name);
      return { status: 201, body: { ref } };
    }
    if (method === 'GET' && p === `/repos/${FULL}/compare/main...qos/feature`) {
      return {
        status: 200,
        body: {
          files: [
            { filename: 'tests/login.spec.ts', status: 'added' },
            { filename: 'src/app.ts', status: 'modified' },
          ],
        },
      };
    }
    if (method === 'GET' && p === `/repos/${FULL}/pulls`) {
      const head = u.searchParams.get('head')?.split(':')[1];
      return { status: 200, body: this.pulls.filter((x) => x.head === head).map((x) => this.pull(x)) };
    }
    if (method === 'POST' && p === `/repos/${FULL}/pulls`) {
      const req = JSON.parse(String(body)) as { head: string; base: string };
      const pr = { number: this.pulls.length + 1, head: req.head, base: req.base };
      this.pulls.push(pr);
      return { status: 201, body: this.pull(pr) };
    }
    const prMatch = /^\/repos\/octo-demo\/sample-app\/pulls\/(\d+)$/.exec(p);
    if (method === 'GET' && prMatch) {
      const pr = this.pulls.find((x) => x.number === Number(prMatch[1]));
      return pr ? { status: 200, body: this.pull(pr) } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'GET' && p === `/repos/${FULL}/branches/main`)
      return { status: 200, body: { name: 'main', protected: true } };
    return { status: 404, body: { message: 'Not Found' } };
  }

  private pull(x: { number: number; head: string; base: string }) {
    return {
      number: x.number,
      state: 'open',
      merged_at: null,
      merge_commit_sha: null,
      html_url: `https://github.com/${FULL}/pull/${x.number}`,
      head: { ref: x.head },
      base: { ref: x.base },
    };
  }
}
