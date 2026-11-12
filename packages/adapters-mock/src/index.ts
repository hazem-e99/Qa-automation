import { createHash } from 'node:crypto';
import {
  CapabilityMissingError,
  ProviderError,
  QOS_BRANCH_PREFIX,
  type CanonicalCommit,
  type CapabilityId,
  type CapabilityManifest,
  type CloneCredential,
  type ConnectionContext,
  type ConnectionTestResult,
  type ExternalRefData,
  type Page,
  type ProviderAdapter,
  type ProviderErrorKind,
  type RepoInfo,
  type RepoSummary,
  type RepositoryProvider,
} from '@qos/ports';

/**
 * Mock adapters (doc 11 §8): deterministic, in-memory, with capability toggles and fault injection.
 *
 * Mock credentials are plain strings. `invalid` fails authentication. A value containing
 * `scopes=a,b,c` grants only those scopes; any other value grants every scope. Example:
 * `mock-token;scopes=repo,issues:read`.
 */
const MOCK_SCOPES = ['repo', 'repo:write', 'issues:read', 'issues:write'] as const;

function scopesOf(secret: string): string[] {
  if (secret === 'invalid')
    throw new ProviderError('auth_failed', 'credential rejected', { providerCode: '401' });
  const m = /scopes=([a-z:,]*)/.exec(secret);
  return m ? m[1]!.split(',').filter(Boolean) : [...MOCK_SCOPES];
}

/** Test controls shared by every mock adapter instance. */
export class MockControls {
  readonly disabled = new Set<CapabilityId>();
  private faults: { kind: ProviderErrorKind; retryAfterMs?: number }[] = [];
  calls = 0;

  /** The next `times` calls fail with this error kind. */
  failNext(kind: ProviderErrorKind, times = 1, retryAfterMs?: number): void {
    for (let i = 0; i < times; i++) this.faults.push({ kind, ...(retryAfterMs ? { retryAfterMs } : {}) });
  }

  reset(): void {
    this.disabled.clear();
    this.faults = [];
    this.calls = 0;
  }

  /** Called at the start of every adapter operation. */
  enter(): void {
    this.calls++;
    const f = this.faults.shift();
    if (f) {
      throw new ProviderError(
        f.kind,
        `simulated ${f.kind}`,
        f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {},
      );
    }
  }
}

abstract class MockAdapter implements ProviderAdapter {
  constructor(readonly controls: MockControls = new MockControls()) {}

  protected abstract readonly base: CapabilityManifest;
  /** capability → scope the credential must hold for it. */
  protected abstract readonly scopeFor: Readonly<Partial<Record<CapabilityId, string>>>;

  manifest(): CapabilityManifest {
    return {
      ...this.base,
      capabilities: this.base.capabilities.filter((c) => !this.controls.disabled.has(c)),
    };
  }

  async testConnection(ctx: ConnectionContext): Promise<ConnectionTestResult> {
    this.controls.enter();
    const scopes = scopesOf(await ctx.secret());
    ctx.log.info({ scopes: scopes.length }, 'mock connection test');
    return {
      identity: 'mock-user',
      scopesDiscovered: scopes,
      permissionChecks: this.manifest().capabilities.map((capability) => {
        const scope = this.scopeFor[capability];
        const ok = !scope || scopes.includes(scope);
        return ok ? { capability, ok } : { capability, ok, missing: scope };
      }),
    };
  }

  protected require(c: CapabilityId): void {
    if (!this.manifest().capabilities.includes(c)) throw new CapabilityMissingError([c]);
  }
}

interface MockRepo extends RepoInfo {
  readonly commits: readonly CanonicalCommit[];
  readonly files: Readonly<Record<string, string>>;
  readonly branches: Set<string>;
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

function seedRepos(): Map<string, MockRepo> {
  const repos = new Map<string, MockRepo>();
  for (let r = 1; r <= 7; r++) {
    const id = String(1000 + r);
    const commits = Array.from({ length: 45 }, (_, i) => ({
      sha: sha(`${id}-${i}`),
      message: `Change ${i + 1} in demo-repo-${r}`,
      author: i % 2 ? 'demo.dev@example.test' : 'demo.qa@example.test',
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      changedPaths: [`src/module-${i % 5}.ts`],
    }));
    repos.set(id, {
      id,
      path: `demo-org/demo-repo-${r}`,
      defaultBranch: 'main',
      url: `https://mock.example.test/demo-org/demo-repo-${r}`,
      visibility: 'private',
      commits,
      files: { 'README.md': `# demo-repo-${r}\n`, 'tests/example.spec.ts': "test('ok', () => {});\n" },
      branches: new Set(['main']),
    });
  }
  return repos;
}

const PAGE = 20;
const page = <T>(all: readonly T[], cursor?: string): Page<T> => {
  const start = cursor ? Number.parseInt(cursor, 10) : 0;
  if (!Number.isInteger(start) || start < 0 || start > all.length) {
    throw new ProviderError('validation', 'invalid cursor', { field: 'cursor' });
  }
  const end = start + PAGE;
  const stop = Math.min(end, all.length);
  return {
    items: all.slice(start, end),
    ...(end < all.length ? { nextCursor: String(end) } : {}),
    resumeCursor: String(stop),
  };
};

export class MockRepositoryProvider extends MockAdapter implements RepositoryProvider {
  static readonly TYPE = 'mock_repository';
  private readonly repos = seedRepos();

  protected readonly base: CapabilityManifest = {
    providerType: MockRepositoryProvider.TYPE,
    family: 'source_control',
    adapterVersion: '1.0.0',
    displayName: 'Demo repository (mock)',
    capabilities: ['repo.read@1', 'repo.commits.list@1', 'repo.branch.create@1', 'repo.clone_token.issue@1'],
    limits: { maxPageSize: PAGE },
    authStrategies: ['pat'],
    webhook: {
      verification: 'hmac_sha256',
      deliveryIdHeader: 'x-mock-delivery',
      signatureHeader: 'x-mock-signature',
      eventTypeHeader: 'x-mock-event',
    },
    demoOnly: true,
  };
  protected readonly scopeFor = {
    'repo.read@1': 'repo',
    'repo.commits.list@1': 'repo',
    'repo.branch.create@1': 'repo:write',
    'repo.clone_token.issue@1': 'repo',
  } as const;

  async listResources(
    _ctx: ConnectionContext,
    q: { search?: string; cursor?: string },
  ): Promise<Page<RepoSummary>> {
    this.controls.enter();
    this.require('repo.read@1');
    const term = (q.search ?? '').toLowerCase();
    const all = [...this.repos.values()]
      .filter((r) => r.path.includes(term))
      .map(({ id, path }) => ({ id, path }));
    return page(all, q.cursor);
  }

  async getRepo(_ctx: ConnectionContext, repoId: string): Promise<RepoInfo> {
    this.controls.enter();
    this.require('repo.read@1');
    const { id, path, defaultBranch, url, visibility } = this.repo(repoId);
    return { id, path, defaultBranch, url, visibility };
  }

  async readFile(_ctx: ConnectionContext, repoId: string, path: string): Promise<Uint8Array | null> {
    this.controls.enter();
    this.require('repo.read@1');
    const content = this.repo(repoId).files[path];
    return content === undefined ? null : new TextEncoder().encode(content);
  }

  async listCommits(
    _ctx: ConnectionContext,
    repoId: string,
    branch: string,
    cursor?: string,
  ): Promise<Page<CanonicalCommit>> {
    this.controls.enter();
    this.require('repo.commits.list@1');
    const repo = this.repo(repoId);
    if (!repo.branches.has(branch)) throw new ProviderError('not_found', 'branch not found');
    return page(repo.commits, cursor);
  }

  async createBranch(
    _ctx: ConnectionContext,
    repoId: string,
    name: string,
    fromRef: string,
  ): Promise<ExternalRefData> {
    this.controls.enter();
    this.require('repo.branch.create@1');
    const repo = this.repo(repoId);
    // Safety rules (doc 12 §4.1): only qos/ branches, never the default branch.
    if (!name.startsWith(QOS_BRANCH_PREFIX) || name === repo.defaultBranch) {
      throw new ProviderError('validation', 'branch name must start with qos/', { field: 'name' });
    }
    if (repo.branches.has(name)) throw new ProviderError('conflict', 'branch exists');
    repo.branches.add(name);
    return {
      externalType: 'branch',
      externalId: `${repoId}:${name}`,
      externalUrl: `${repo.url}/tree/${name}`,
      snapshot: { name, fromRef },
    };
  }

  async issueCloneCredential(
    _ctx: ConnectionContext,
    repoId: string,
    ttlSeconds: number,
  ): Promise<CloneCredential> {
    this.controls.enter();
    this.require('repo.clone_token.issue@1');
    const repo = this.repo(repoId);
    return {
      url: `${repo.url}.git`,
      token: `mock-ro-${sha(repoId + Date.now()).slice(0, 16)}`,
      expiresAt: new Date(Date.now() + Math.min(ttlSeconds, 3600) * 1000).toISOString(),
      readOnly: true,
    };
  }

  /** Test control: appends commits to a repository's default branch (simulates new pushes). */
  addCommits(repoId: string, count: number): void {
    const repo = this.repo(repoId);
    const commits = repo.commits as CanonicalCommit[];
    for (let i = 0; i < count; i++) {
      const n = commits.length;
      commits.push({
        sha: sha(`${repoId}-${n}`),
        message: `Change ${n + 1}`,
        author: 'demo.dev@example.test',
        timestamp: new Date(Date.UTC(2026, 0, 2, 0, n)).toISOString(),
      });
    }
  }

  private repo(id: string): MockRepo {
    const repo = this.repos.get(id);
    if (!repo) throw new ProviderError('not_found', 'repository not found');
    return repo;
  }
}

/** Issue tracker mock. Only the connection test is used before P8. */
export class MockIssueTracker extends MockAdapter {
  static readonly TYPE = 'mock_issue_tracker';
  protected readonly base: CapabilityManifest = {
    providerType: MockIssueTracker.TYPE,
    family: 'issue_tracking',
    adapterVersion: '1.0.0',
    displayName: 'Demo issue tracker (mock)',
    capabilities: [
      'issues.metadata.read@1',
      'issues.create@1',
      'issues.get@1',
      'issues.update@1',
      'issues.list_changed@1',
      'issues.comment@1',
      'issues.search_by_marker@1',
    ],
    limits: { richText: 'markdown' },
    authStrategies: ['pat'],
    demoOnly: true,
  };
  protected readonly scopeFor = {
    'issues.metadata.read@1': 'issues:read',
    'issues.get@1': 'issues:read',
    'issues.list_changed@1': 'issues:read',
    'issues.search_by_marker@1': 'issues:read',
    'issues.create@1': 'issues:write',
    'issues.update@1': 'issues:write',
    'issues.comment@1': 'issues:write',
  } as const;
}
