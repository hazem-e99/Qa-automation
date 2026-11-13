import {
  CapabilityMissingError,
  ProviderError,
  QOS_BRANCH_PREFIX,
  type CanonicalCommit,
  type CanonicalPullRequest,
  type CapabilityId,
  type CapabilityManifest,
  type ChangedFile,
  type CloneCredential,
  type ConnectionContext,
  type ConnectionTestResult,
  type ExternalRefData,
  type Page,
  type RepoInfo,
  type RepoSummary,
  type RepositoryProvider,
} from '@qos/ports';

/**
 * GitHub repository adapter (doc 13 §2), REST API v3. Pure translation: GitHub DTOs ↔ canonical
 * models, errors normalized to ProviderError. Repository ids are GitHub's numeric ids, which
 * survive renames and transfers.
 *
 * Not declared, on purpose:
 *  - `repo.clone_token.issue`: a PAT cannot be down-scoped to read-only, so sandbox clones go
 *    through the QualityOS archive proxy instead (doc 13 §2, P6).
 *  - `repo.commit.push`: pushing uses git transport through the publisher (P9).
 */
const PAGE_SIZE = 50;
const API = 'https://api.github.com';

const CAPABILITIES: CapabilityId[] = [
  'repo.read@1',
  'repo.commits.list@1',
  'repo.diff.read@1',
  'repo.branch.create@1',
  'repo.pr.create@1',
  'repo.pr.read@1',
  'repo.branch.protection.read@1',
];

interface GhRepo {
  id: number;
  full_name: string;
  default_branch: string;
  html_url: string;
  visibility?: string;
  private: boolean;
}
interface GhCommit {
  sha: string;
  commit: { message: string; author: { name?: string; email?: string; date?: string } | null };
  author?: { login?: string } | null;
}
interface GhPull {
  number: number;
  state: 'open' | 'closed';
  merged_at: string | null;
  merge_commit_sha: string | null;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

export class GitHubRepositoryProvider implements RepositoryProvider {
  static readonly TYPE = 'github';
  private readonly fullNames = new Map<string, string>();

  manifest(): CapabilityManifest {
    return {
      providerType: GitHubRepositoryProvider.TYPE,
      family: 'source_control',
      adapterVersion: '1.0.0',
      displayName: 'GitHub',
      capabilities: CAPABILITIES,
      limits: { maxPageSize: PAGE_SIZE, richText: 'markdown', rateLimitHint: '5000/h per token' },
      authStrategies: ['pat'],
      webhook: {
        verification: 'hmac_sha256',
        signatureHeader: 'x-hub-signature-256',
        deliveryIdHeader: 'x-github-delivery',
        eventTypeHeader: 'x-github-event',
      },
    };
  }

  async testConnection(ctx: ConnectionContext): Promise<ConnectionTestResult> {
    const me = await this.call<{ login: string }>(ctx, 'GET', '/user');
    // Classic tokens list their scopes; fine-grained tokens do not, so read access is probed and
    // write access is left unconfirmed until first use.
    const scopesHeader = me.headers['x-oauth-scopes'];
    const scopes = scopesHeader
      ? scopesHeader
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    let canRead = scopes.includes('repo') || scopes.includes('public_repo');
    if (!scopesHeader) {
      canRead = await this.call(ctx, 'GET', '/user/repos?per_page=1').then(
        () => true,
        () => false,
      );
    }
    const classicWrite = scopes.includes('repo');
    type Check = ConnectionTestResult['permissionChecks'][number];
    const checks = CAPABILITIES.map((capability): Check => {
      const write = capability === 'repo.branch.create@1' || capability === 'repo.pr.create@1';
      if (!write)
        return canRead ? { capability, ok: true } : { capability, ok: false, missing: 'contents:read' };
      if (classicWrite) return { capability, ok: true };
      return { capability, ok: false, missing: scopesHeader ? 'repo' : 'unverified for fine-grained tokens' };
    });
    const expiry = me.headers['github-authentication-token-expiration'];
    const expiresAt = expiry ? new Date(expiry.replace(' UTC', 'Z').replace(' ', 'T')) : null;
    return {
      identity: me.body.login,
      scopesDiscovered: scopes,
      permissionChecks: checks,
      ...(expiresAt && !Number.isNaN(expiresAt.getTime()) ? { expiresAt: expiresAt.toISOString() } : {}),
    };
  }

  async listResources(
    ctx: ConnectionContext,
    q: { search?: string; cursor?: string },
  ): Promise<Page<RepoSummary>> {
    const page = cursorPage(q.cursor);
    const res = await this.call<GhRepo[]>(
      ctx,
      'GET',
      `/user/repos?per_page=${PAGE_SIZE}&page=${page}&sort=full_name&affiliation=owner,collaborator,organization_member`,
    );
    const term = (q.search ?? '').toLowerCase();
    const items = res.body
      .filter((r) => r.full_name.toLowerCase().includes(term))
      .map((r) => ({ id: String(r.id), path: r.full_name }));
    return { items, ...(hasNext(res.headers.link) ? { nextCursor: String(page + 1) } : {}) };
  }

  async getRepo(ctx: ConnectionContext, repoId: string): Promise<RepoInfo> {
    if (!/^\d{1,15}$/.test(repoId)) throw new ProviderError('not_found', 'repository not found');
    const { body: r } = await this.call<GhRepo>(ctx, 'GET', `/repositories/${repoId}`);
    this.fullNames.set(repoId, r.full_name);
    const visibility = r.visibility === 'internal' ? 'internal' : r.private ? 'private' : 'public';
    return {
      id: String(r.id),
      path: r.full_name,
      defaultBranch: r.default_branch,
      url: r.html_url,
      visibility,
    };
  }

  async readFile(
    ctx: ConnectionContext,
    repoId: string,
    path: string,
    ref: string,
  ): Promise<Uint8Array | null> {
    const repo = await this.repoPath(ctx, repoId);
    try {
      const { body } = await this.call<{ type: string; encoding: string; content: string }>(
        ctx,
        'GET',
        `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
      );
      if (body.type !== 'file' || body.encoding !== 'base64') return null;
      return new Uint8Array(Buffer.from(body.content, 'base64'));
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'not_found') return null;
      throw e;
    }
  }

  async listCommits(
    ctx: ConnectionContext,
    repoId: string,
    branch: string,
    cursor?: string,
  ): Promise<Page<CanonicalCommit>> {
    const repo = await this.repoPath(ctx, repoId);
    const page = cursorPage(cursor);
    const res = await this.call<GhCommit[]>(
      ctx,
      'GET',
      `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${PAGE_SIZE}&page=${page}`,
    );
    const items = res.body.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.author?.login ?? c.commit.author?.email ?? c.commit.author?.name ?? 'unknown',
      timestamp: c.commit.author?.date ?? new Date(0).toISOString(),
    }));
    return {
      items,
      ...(hasNext(res.headers.link) ? { nextCursor: String(page + 1) } : {}),
      // GitHub lists newest first; an incremental run restarts from the top and relies on upserts.
      resumeCursor: '1',
    };
  }

  async diff(
    ctx: ConnectionContext,
    repoId: string,
    baseRef: string,
    headRef: string,
  ): Promise<ChangedFile[]> {
    const repo = await this.repoPath(ctx, repoId);
    const { body } = await this.call<{ files?: { filename: string; status: string }[] }>(
      ctx,
      'GET',
      `/repos/${repo}/compare/${refPath(baseRef)}...${refPath(headRef)}`,
    );
    return (body.files ?? []).map((f) => ({
      path: f.filename,
      status:
        f.status === 'added'
          ? 'added'
          : f.status === 'removed'
            ? 'removed'
            : f.status === 'renamed'
              ? 'renamed'
              : 'modified',
    }));
  }

  async createBranch(
    ctx: ConnectionContext,
    repoId: string,
    name: string,
    fromRef: string,
  ): Promise<ExternalRefData> {
    const info = await this.getRepo(ctx, repoId);
    // Safety rules (doc 12 §4.1): only qos/ branches, never the default branch.
    if (
      !name.startsWith(QOS_BRANCH_PREFIX) ||
      name === info.defaultBranch ||
      !/^[A-Za-z0-9._/-]{5,200}$/.test(name)
    ) {
      throw new ProviderError('validation', 'branch name must start with qos/', { field: 'name' });
    }
    const base = await this.call<{ object: { sha: string } }>(
      ctx,
      'GET',
      `/repos/${info.path}/git/ref/heads/${refPath(fromRef)}`,
    );
    await this.call(ctx, 'POST', `/repos/${info.path}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha: base.body.object.sha,
    });
    return {
      externalType: 'branch',
      externalId: `${repoId}:${name}`,
      externalUrl: `${info.url}/tree/${name}`,
      snapshot: { name, fromRef, sha: base.body.object.sha },
    };
  }

  async createPullRequest(
    ctx: ConnectionContext,
    repoId: string,
    req: { head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<ExternalRefData> {
    if (!req.head.startsWith(QOS_BRANCH_PREFIX)) {
      throw new ProviderError('validation', 'head branch must start with qos/', { field: 'head' });
    }
    const repo = await this.repoPath(ctx, repoId);
    const owner = repo.split('/')[0]!;
    // Idempotency (doc 12 §5.5): an existing PR for the same head branch is returned as is.
    const existing = await this.call<GhPull[]>(
      ctx,
      'GET',
      `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${req.head}`)}&per_page=1`,
    );
    const pr =
      existing.body[0] ??
      (
        await this.call<GhPull>(ctx, 'POST', `/repos/${repo}/pulls`, {
          head: req.head,
          base: req.base,
          title: req.title.slice(0, 250),
          body: req.body,
          draft: req.draft,
        })
      ).body;
    return {
      externalType: 'pull_request',
      externalId: `${repoId}:${pr.number}`,
      externalUrl: pr.html_url,
      snapshot: { number: pr.number, state: pullState(pr), head: pr.head.ref, base: pr.base.ref },
    };
  }

  async getPullRequest(
    ctx: ConnectionContext,
    repoId: string,
    prNumber: number,
  ): Promise<CanonicalPullRequest> {
    const repo = await this.repoPath(ctx, repoId);
    const { body: pr } = await this.call<GhPull>(ctx, 'GET', `/repos/${repo}/pulls/${prNumber}`);
    return {
      number: pr.number,
      state: pullState(pr),
      head: pr.head.ref,
      base: pr.base.ref,
      url: pr.html_url,
      ...(pr.merge_commit_sha && pr.merged_at ? { mergeSha: pr.merge_commit_sha } : {}),
    };
  }

  async getBranchProtection(ctx: ConnectionContext, repoId: string, branch: string) {
    const repo = await this.repoPath(ctx, repoId);
    // The branch endpoint reports `protected` without needing admin rights on the repository.
    const { body } = await this.call<{ protected: boolean }>(
      ctx,
      'GET',
      `/repos/${repo}/branches/${refPath(branch)}`,
    );
    return { protected: body.protected === true };
  }

  async issueCloneCredential(): Promise<CloneCredential> {
    throw new CapabilityMissingError(['repo.clone_token.issue@1']);
  }

  private async repoPath(ctx: ConnectionContext, repoId: string): Promise<string> {
    const known = this.fullNames.get(repoId);
    if (known) return known;
    return (await this.getRepo(ctx, repoId)).path;
  }

  /** One API call with GitHub's error and rate-limit semantics mapped to ProviderError. */
  private async call<T = unknown>(
    ctx: ConnectionContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ body: T; headers: Readonly<Record<string, string>> }> {
    const base = (ctx.baseUrl ?? API).replace(/\/+$/, '');
    const token = await ctx.secret();
    let res;
    try {
      res = await ctx.http.request(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'qualityos',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      const reason = (e as { reason?: string } | null)?.reason;
      throw new ProviderError(
        reason === 'timeout' ? 'timeout' : 'unavailable',
        'GitHub could not be reached',
      );
    }
    if (res.status >= 200 && res.status < 300) {
      const text = new TextDecoder().decode(res.body);
      return { body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
    }
    throw toProviderError(res.status, res.headers, ctx.now());
  }
}

function toProviderError(status: number, h: Readonly<Record<string, string>>, now: Date): ProviderError {
  const code = String(status);
  const retryAfter = Number(h['retry-after']);
  if (
    status === 429 ||
    ((status === 403 || status === 429) && (h['x-ratelimit-remaining'] === '0' || retryAfter > 0))
  ) {
    const resetMs = Number(h['x-ratelimit-reset']) * 1000 - now.getTime();
    const retryAfterMs = retryAfter > 0 ? retryAfter * 1000 : resetMs > 0 ? resetMs : 60_000;
    return new ProviderError('rate_limited', 'GitHub rate limit reached', {
      retryAfterMs,
      providerCode: code,
    });
  }
  if (status === 401)
    return new ProviderError('auth_failed', 'GitHub rejected the credential', { providerCode: code });
  if (status === 403)
    return new ProviderError('permission_denied', 'GitHub denied access', { providerCode: code });
  if (status === 404) return new ProviderError('not_found', 'not found on GitHub', { providerCode: code });
  if (status === 409)
    return new ProviderError('conflict', 'GitHub reported a conflict', { providerCode: code });
  if (status === 422)
    return new ProviderError('validation', 'GitHub rejected the request', { providerCode: code });
  if (status === 504) return new ProviderError('timeout', 'GitHub timed out', { providerCode: code });
  if (status >= 500) return new ProviderError('unavailable', 'GitHub is unavailable', { providerCode: code });
  return new ProviderError('unknown', 'unexpected GitHub response', { providerCode: code });
}

const pullState = (pr: GhPull): CanonicalPullRequest['state'] =>
  pr.merged_at ? 'merged' : pr.state === 'open' ? 'open' : 'closed';

function cursorPage(cursor?: string): number {
  if (cursor === undefined) return 1;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 1 || n > 10_000)
    throw new ProviderError('validation', 'invalid cursor', { field: 'cursor' });
  return n;
}

/** Branch names keep their slashes in URL paths (GitHub expects `qos/feature`, not `qos%2Ffeature`). */
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

const hasNext = (link: string | undefined) => !!link && /<[^>]+>;\s*rel="next"/.test(link);
