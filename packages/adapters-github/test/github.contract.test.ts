import { repositoryContract, spyContext } from '@qos/contract-tests';
import { describe, expect, it } from 'vitest';
import { GitHubRepositoryProvider } from '../src/index.js';
import { FIXTURE_TOKEN, FixtureGitHub, REPO_ID } from './fixture-http.js';

const http = new FixtureGitHub();

repositoryContract('github', () => ({
  adapter: new GitHubRepositoryProvider(),
  mode: 'recorded',
  secret: FIXTURE_TOKEN,
  repoId: REPO_ID,
  http,
  injectFault: (kind, retryAfterMs) => {
    const status = {
      auth_failed: 401,
      permission_denied: 403,
      unavailable: 503,
      timeout: 504,
      not_found: 404,
    }[kind as string];
    if (kind === 'rate_limited')
      http.failNext(403, {
        'x-ratelimit-remaining': '0',
        'retry-after': String((retryAfterMs ?? 1000) / 1000),
      });
    else http.failNext(status ?? 500);
  },
  reset: () => http.reset(),
}));

describe('GitHub specifics', () => {
  const adapter = new GitHubRepositoryProvider();
  const ctx = () => spyContext(FIXTURE_TOKEN, undefined, http).ctx;

  it('sends the documented headers and never puts the token in a URL', async () => {
    http.reset();
    await adapter.getRepo(ctx(), REPO_ID);
    const call = http.calls[0]!;
    expect(call.url).toBe('https://api.github.com/repositories/4242');
    expect(call.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${FIXTURE_TOKEN}`,
    });
    expect(http.calls.every((c) => !c.url.includes(FIXTURE_TOKEN))).toBe(true);
  });

  it('classic token: reads scopes and token expiry; write capabilities follow the repo scope', async () => {
    http.scopes = 'repo, read:org';
    const r = await adapter.testConnection(ctx());
    expect(r).toMatchObject({
      identity: 'demo-dev',
      scopesDiscovered: ['repo', 'read:org'],
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect(r.permissionChecks.every((c) => c.ok)).toBe(true);
    http.scopes = 'public_repo';
    const limited = await adapter.testConnection(ctx());
    expect(limited.permissionChecks.find((c) => c.capability === 'repo.pr.create@1')).toMatchObject({
      ok: false,
      missing: 'repo',
    });
  });

  it('fine-grained token (no scopes header): read is probed, write stays unverified', async () => {
    http.scopes = null;
    const r = await adapter.testConnection(ctx());
    expect(r.scopesDiscovered).toEqual([]);
    expect(r.permissionChecks.find((c) => c.capability === 'repo.read@1')?.ok).toBe(true);
    expect(r.permissionChecks.find((c) => c.capability === 'repo.branch.create@1')).toMatchObject({
      ok: false,
      missing: 'unverified for fine-grained tokens',
    });
    http.scopes = 'repo, read:org';
  });

  it('maps a primary rate limit with x-ratelimit-reset to retryAfterMs', async () => {
    const now = new Date('2026-11-12T10:00:00Z');
    const c = { ...ctx(), now: () => now };
    http.failNext(403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(now.getTime() / 1000 + 90),
    });
    await expect(adapter.getRepo(c, REPO_ID)).rejects.toMatchObject({
      kind: 'rate_limited',
      details: { retryAfterMs: 90_000 },
    });
    http.failNext(403); // a plain 403 is a permission problem, not a rate limit
    await expect(adapter.getRepo(c, REPO_ID)).rejects.toMatchObject({ kind: 'permission_denied' });
  });

  it('reads files, diffs refs, reports branch protection', async () => {
    http.reset();
    expect(new TextDecoder().decode((await adapter.readFile(ctx(), REPO_ID, 'README.md', 'main'))!)).toBe(
      '# sample-app\n',
    );
    expect(await adapter.diff(ctx(), REPO_ID, 'main', 'qos/feature')).toEqual([
      { path: 'tests/login.spec.ts', status: 'added' },
      { path: 'src/app.ts', status: 'modified' },
    ]);
    expect(await adapter.getBranchProtection(ctx(), REPO_ID, 'main')).toEqual({ protected: true });
  });

  it('opens one pull request per head branch (idempotent) and refuses non-qos heads', async () => {
    http.reset();
    const req = {
      head: 'qos/generated-tests',
      base: 'main',
      title: 'Add tests',
      body: 'Generated',
      draft: true,
    };
    const first = await adapter.createPullRequest(ctx(), REPO_ID, req);
    const again = await adapter.createPullRequest(ctx(), REPO_ID, req);
    expect(again.externalId).toBe(first.externalId);
    expect(http.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(await adapter.getPullRequest(ctx(), REPO_ID, 1)).toMatchObject({
      number: 1,
      state: 'open',
      head: 'qos/generated-tests',
    });
    await expect(
      adapter.createPullRequest(ctx(), REPO_ID, { ...req, head: 'feature/x' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('creating an existing branch is a validation error from GitHub (422)', async () => {
    http.reset();
    await adapter.createBranch(ctx(), REPO_ID, 'qos/twice', 'main');
    await expect(adapter.createBranch(ctx(), REPO_ID, 'qos/twice', 'main')).rejects.toMatchObject({
      kind: 'validation',
    });
  });
});
