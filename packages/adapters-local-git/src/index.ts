import { execFile, spawn } from 'node:child_process';
import { realpathSync, statSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  CapabilityMissingError,
  ProviderError,
  type CanonicalCommit,
  type CapabilityManifest,
  type ChangedFile,
  type CloneCredential,
  type ConnectionContext,
  type ConnectionTestResult,
  type Page,
  type RepoInfo,
  type RepoSummary,
  type RepositoryProvider,
} from '@qos/ports';

/**
 * Local Git repository adapter (doc 13 §7, T-P2-05): repositories on disk, read with the `git`
 * CLI. The connection's base URL is one of the allowed roots (`QOS_LOCAL_GIT_ROOTS`, given by the
 * composition root); repository ids are paths relative to that root.
 *
 * Safety:
 *  - `git` runs without a shell, with argument arrays; refs and paths are validated and can never
 *    start with `-`; every resolved path (symlinks included) must stay inside the root.
 *  - Repository configuration cannot run programs here: external diff drivers and textconv are
 *    disabled, hooks point at an empty path, fsmonitor is off, and global/system config is not read.
 *  - Read-only: no command writes to the repository. Branch creation and push (◐ in doc 33,
 *    "separate local bare remote") are not offered yet, and there is no pull request capability.
 */
export interface LocalGitOptions {
  /** Absolute directories repositories may live in. Anything else is refused. */
  readonly roots: readonly string[];
  /** Commits per page. */
  readonly pageSize?: number;
  /** `git` executable; defaults to the one on PATH. */
  readonly gitBinary?: string;
  readonly timeoutMs?: number;
}

const REPO_ID = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,2}$/;
/** Branch, tag or sha, optionally with ~n / ^n suffixes. Never an option, never a range. */
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}([~^][0-9]{0,4}){0,5}$/;
const FILE_PATH = /^(?!-)(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0]{1,1000}$/;
const SHA = /^[0-9a-f]{40}$/;
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export class LocalGitRepositoryProvider implements RepositoryProvider {
  static readonly TYPE = 'local_git';
  private readonly roots: string[];
  private readonly pageSize: number;
  private readonly git: string;
  private readonly timeoutMs: number;

  constructor(opts: LocalGitOptions) {
    this.roots = opts.roots.map((r) => normalizeRoot(r)).filter((r): r is string => r !== null);
    this.pageSize = opts.pageSize ?? 50;
    this.git = opts.gitBinary ?? 'git';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  manifest(): CapabilityManifest {
    return {
      providerType: LocalGitRepositoryProvider.TYPE,
      family: 'source_control',
      adapterVersion: '0.1.0',
      displayName: 'Local Git',
      capabilities: ['repo.read@1', 'repo.commits.list@1', 'repo.diff.read@1'],
      limits: { maxPageSize: this.pageSize, richText: 'plain' },
      authStrategies: ['none'],
      locator: 'local_path',
      webhook: { verification: 'none' },
    };
  }

  /** Runs git with a fixed, safe configuration. Output is returned as a Buffer. */
  private run(
    args: readonly string[],
    opts: { cwd?: string; allowFail?: boolean } = {},
  ): Promise<{ code: number; out: Buffer; err: string }> {
    const safety = [
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${NULL_DEVICE}`,
      '-c',
      'safe.directory=*',
      '-c',
      'core.quotePath=false',
      '-c',
      'diff.external=',
    ];
    return new Promise((resolve, reject) => {
      execFile(
        this.git,
        [...safety, ...args],
        {
          cwd: opts.cwd ?? tmpdir(),
          encoding: 'buffer',
          maxBuffer: 16 * 1024 * 1024,
          timeout: this.timeoutMs,
          windowsHide: true,
          env: {
            PATH: process.env.PATH ?? '',
            SYSTEMROOT: process.env.SYSTEMROOT ?? '',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: NULL_DEVICE,
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0',
            HOME: tmpdir(),
            LC_ALL: 'C',
          },
        },
        (error, stdout, stderr) => {
          const err = stderr.toString('utf8');
          if (error && (error as { killed?: boolean }).killed) {
            reject(new ProviderError('timeout', 'git did not answer in time'));
            return;
          }
          if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new ProviderError('unavailable', 'git is not installed'));
            return;
          }
          const code =
            typeof (error as { code?: unknown } | null)?.code === 'number'
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;
          if (code !== 0 && !opts.allowFail) {
            reject(new ProviderError('unknown', 'git command failed', { providerCode: String(code) }));
            return;
          }
          resolve({ code, out: stdout, err });
        },
      );
    });
  }

  /** The connection's root, which must be one of the allowed roots. */
  private root(ctx: ConnectionContext): string {
    const wanted = ctx.baseUrl ? normalizeRoot(ctx.baseUrl) : null;
    const root = wanted && this.roots.find((r) => samePath(r, wanted));
    if (!root) {
      throw new ProviderError('validation', 'the folder is not one of the allowed Local Git roots', {
        field: 'baseUrl',
      });
    }
    return root;
  }

  /** Absolute repository path, guaranteed to be inside the root even through symlinks. */
  private repoPath(ctx: ConnectionContext, repoId: string): string {
    if (!REPO_ID.test(repoId) || repoId.split('/').some((s) => s === '.' || s === '..')) {
      throw new ProviderError('not_found', 'repository not found');
    }
    const root = this.root(ctx);
    const candidate = path.join(root, ...repoId.split('/'));
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      throw new ProviderError('not_found', 'repository not found');
    }
    if (!isInside(root, real) || !isRepository(real))
      throw new ProviderError('not_found', 'repository not found');
    return real;
  }

  private async resolveCommit(repo: string, ref: string): Promise<string> {
    if (!REF.test(ref)) throw new ProviderError('validation', 'invalid ref', { field: 'ref' });
    const r = await this.run(
      ['-C', repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
      { allowFail: true },
    );
    const sha = r.out.toString('utf8').trim();
    if (r.code !== 0 || !SHA.test(sha)) throw new ProviderError('not_found', 'ref not found');
    return sha;
  }

  async testConnection(ctx: ConnectionContext): Promise<ConnectionTestResult> {
    const root = this.root(ctx);
    const version = (await this.run(['--version'])).out.toString('utf8').trim();
    const repos = listRepositories(root);
    return {
      identity: `${path.basename(root)} (${repos.length} repositories, ${version})`,
      scopesDiscovered: ['read'],
      permissionChecks: this.manifest().capabilities.map((capability) => ({ capability, ok: true })),
    };
  }

  async listResources(
    ctx: ConnectionContext,
    q: { search?: string; cursor?: string },
  ): Promise<Page<RepoSummary>> {
    const root = this.root(ctx);
    const all = listRepositories(root).filter(
      (id) => !q.search || id.toLowerCase().includes(q.search.toLowerCase()),
    );
    const start = q.cursor ? Number(q.cursor) || 0 : 0;
    const items = all.slice(start, start + 100).map((id) => ({ id, path: id }));
    return start + 100 < all.length ? { items, nextCursor: String(start + 100) } : { items };
  }

  async getRepo(ctx: ConnectionContext, repoId: string): Promise<RepoInfo> {
    const repo = this.repoPath(ctx, repoId);
    const head = await this.run(['-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
      allowFail: true,
    });
    const defaultBranch = head.code === 0 ? head.out.toString('utf8').trim() : 'HEAD';
    return { id: repoId, path: repoId, defaultBranch, url: `local:${repoId}`, visibility: 'private' };
  }

  async readFile(
    ctx: ConnectionContext,
    repoId: string,
    filePath: string,
    ref: string,
  ): Promise<Uint8Array | null> {
    const repo = this.repoPath(ctx, repoId);
    if (!FILE_PATH.test(filePath)) throw new ProviderError('validation', 'invalid path', { field: 'path' });
    const sha = await this.resolveCommit(repo, ref);
    const spec = `${sha}:${filePath}`;
    const kind = await this.run(['-C', repo, 'cat-file', '-t', spec], { allowFail: true });
    if (kind.code !== 0 || kind.out.toString('utf8').trim() !== 'blob') return null;
    // `cat-file blob` prints raw content: no textconv, no filters.
    return new Uint8Array((await this.run(['-C', repo, 'cat-file', 'blob', spec])).out);
  }

  /**
   * Newest first. The cursor pins the head commit of the first page and an offset into its
   * history, so new commits pushed meanwhile neither repeat nor shift later pages.
   */
  async listCommits(
    ctx: ConnectionContext,
    repoId: string,
    branch: string,
    cursor?: string,
  ): Promise<Page<CanonicalCommit>> {
    const repo = this.repoPath(ctx, repoId);
    let head: string;
    let offset = 0;
    if (cursor) {
      const [h, o] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
      if (!h || !SHA.test(h) || !/^\d+$/.test(o ?? ''))
        throw new ProviderError('validation', 'invalid cursor');
      head = h;
      offset = Number(o);
    } else {
      head = await this.resolveCommit(repo, branch);
    }
    const out = await this.run([
      '-C',
      repo,
      'log',
      '--no-color',
      '--topo-order',
      `--skip=${offset}`,
      `--max-count=${this.pageSize + 1}`,
      '--format=%H%x1f%an <%ae>%x1f%aI%x1f%s%x1e',
      head,
      '--',
    ]);
    const items = out.out
      .toString('utf8')
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha, author, timestamp, message] = r.split('\x1f');
        return {
          sha: sha!,
          author: author ?? '',
          timestamp: new Date(timestamp ?? 0).toISOString(),
          message: message ?? '',
        };
      });
    const page = items.slice(0, this.pageSize);
    return items.length > this.pageSize
      ? { items: page, nextCursor: Buffer.from(`${head}:${offset + this.pageSize}`).toString('base64url') }
      : { items: page };
  }

  async diff(
    ctx: ConnectionContext,
    repoId: string,
    baseRef: string,
    headRef: string,
  ): Promise<readonly ChangedFile[]> {
    const repo = this.repoPath(ctx, repoId);
    const [base, head] = [await this.resolveCommit(repo, baseRef), await this.resolveCommit(repo, headRef)];
    const out = await this.run([
      '-C',
      repo,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--name-status',
      '-M',
      '-z',
      base,
      head,
      '--',
    ]);
    const parts = out.out.toString('utf8').split('\0').filter(Boolean);
    const files: ChangedFile[] = [];
    for (let i = 0; i < parts.length;) {
      const code = parts[i++]!;
      if (code.startsWith('R') || code.startsWith('C')) {
        i++; // old path
        files.push({ path: parts[i++]!, status: code.startsWith('R') ? 'renamed' : 'added' });
      } else {
        files.push({
          path: parts[i++]!,
          status: code === 'A' ? 'added' : code === 'D' ? 'removed' : 'modified',
        });
      }
    }
    return files;
  }

  /**
   * A tar archive of one commit, for the sandbox clone proxy (doc 13 §7, P6): the API streams it,
   * so sandboxes never mount host paths. Plain `tar` only, so no configured compression filter runs.
   */
  async streamArchive(ctx: ConnectionContext, repoId: string, ref: string): Promise<Readable> {
    const repo = this.repoPath(ctx, repoId);
    const sha = await this.resolveCommit(repo, ref);
    const child = spawn(
      this.git,
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.hooksPath=${NULL_DEVICE}`,
        '-c',
        'safe.directory=*',
        '-C',
        repo,
        'archive',
        '--format=tar',
        sha,
      ],
      {
        cwd: tmpdir(),
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: NULL_DEVICE,
          HOME: tmpdir(),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.once('exit', () => clearTimeout(timer));
    return child.stdout;
  }

  async issueCloneCredential(
    _ctx: ConnectionContext,
    _repoId: string,
    _ttl: number,
  ): Promise<CloneCredential> {
    // Local repositories are cloned through the API's archive proxy (P6), never with a credential.
    throw new CapabilityMissingError(['repo.clone_token.issue@1']);
  }
}

function normalizeRoot(raw: string): string | null {
  const p = raw.replace(/^file:\/\//, '');
  if (!path.isAbsolute(p)) return null;
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
/** A working copy (`.git` inside) or a bare repository (HEAD + objects + refs). */
function isRepository(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return (
    existsSync(path.join(dir, '.git')) ||
    (existsSync(path.join(dir, 'HEAD')) &&
      existsSync(path.join(dir, 'objects')) &&
      existsSync(path.join(dir, 'refs')))
  );
}
/** Repositories up to two levels below the root, sorted; hidden folders are skipped. */
function listRepositories(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (name.startsWith('.') || !REPO_ID.test(name)) continue;
      const full = path.join(dir, name);
      const id = prefix ? `${prefix}/${name}` : name;
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      if (!isInside(root, real)) continue; // a symlink that leaves the root is never listed
      if (isRepository(full)) out.push(id);
      else if (depth < 2) walk(full, id, depth + 1);
    }
  };
  walk(root, '', 1);
  return out;
}
