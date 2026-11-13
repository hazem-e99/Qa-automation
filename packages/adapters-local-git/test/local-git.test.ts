import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repositoryContract, spyContext } from '@qos/contract-tests';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalGitRepositoryProvider } from '../src/index.js';

/**
 * Real repositories built in a temporary folder with `git fast-import` (one process, fast on every
 * platform): 25 commits on `main`, a rename and a removal for the diff, and a hostile repository
 * whose config tries to run programs.
 */
const base = mkdtempSync(path.join(tmpdir(), 'qos-local-git-'));
const root = path.join(base, 'repos');
const outside = path.join(base, 'outside');
mkdirSync(root);
mkdirSync(outside);
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', args, { cwd, input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

function makeRepo(dir: string, commits: number, extra = ''): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  let stream = '';
  for (let i = 1; i <= commits; i++) {
    const msg = `Change ${i}`;
    const content = `line ${i}\n`;
    stream +=
      `commit refs/heads/main\nmark :${i}\nauthor Dev <dev@example.test> ${1_700_000_000 + i * 60} +0000\n` +
      `committer Dev <dev@example.test> ${1_700_000_000 + i * 60} +0000\ndata ${msg.length}\n${msg}\n` +
      (i > 1 ? `from :${i - 1}\n` : '') +
      `M 100644 inline src/file${i}.txt\ndata ${content.length}\n${content}\n` +
      (i === commits ? `M 100644 inline README.md\ndata 7\n# Shop\n\nD src/file1.txt\n` : '') +
      '\n';
  }
  git(dir, ['fast-import', '--quiet'], stream + extra);
  git(dir, ['checkout', '-q', 'main']);
}

makeRepo(path.join(root, 'shop-app'), 25);
makeRepo(path.join(root, 'team', 'api'), 3);
makeRepo(path.join(outside, 'secret-repo'), 2);
// Hostile configuration: if git honoured it, these commands would create the marker file.
const hostile = path.join(root, 'hostile');
makeRepo(hostile, 2);
const marker = path.join(base, 'pwned');
const cmd = process.platform === 'win32' ? `cmd /c echo x > "${marker}"` : `touch '${marker}'`;
git(hostile, ['config', 'diff.external', cmd]);
git(hostile, ['config', 'core.fsmonitor', cmd]);
git(hostile, ['config', 'diff.evil.textconv', cmd]);
writeFileSync(path.join(hostile, '.gitattributes'), '* diff=evil\n');
let symlinked = false;
try {
  symlinkSync(path.join(outside, 'secret-repo'), path.join(root, 'escape'), 'junction');
  symlinked = true;
} catch {
  /* creating links may be refused on this machine; the test then skips */
}
afterAll(() => rmSync(base, { recursive: true, force: true }));

const adapter = new LocalGitRepositoryProvider({ roots: [root], pageSize: 10 });
const ctx = () => spyContext('', root).ctx;

repositoryContract('local git', () => ({
  adapter,
  mode: 'live',
  secret: 'no-credential-local-git',
  repoId: 'shop-app',
  baseUrl: root,
}));

describe('Local Git specifics (T-P2-05)', () => {
  it('lists repositories up to two levels deep, never outside the root', async () => {
    const page = await adapter.listResources(ctx(), {});
    const ids = page.items.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['shop-app', 'team/api', 'hostile']));
    expect(ids).not.toContain('escape');
    expect(ids.some((id) => id.includes('secret'))).toBe(false);
  });

  it('refuses roots that are not allowed and repository ids that escape', async () => {
    await expect(adapter.testConnection(spyContext('', outside).ctx)).rejects.toMatchObject({
      kind: 'validation',
    });
    for (const bad of ['../outside/secret-repo', 'shop-app/../../outside', '-c', '/etc', 'C:\\Windows']) {
      await expect(adapter.getRepo(ctx(), bad), bad).rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it.skipIf(!symlinked)('a link inside the root that points outside is not a repository', async () => {
    await expect(adapter.getRepo(ctx(), 'escape')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads files at a ref and refuses option-like refs and traversal paths', async () => {
    const readme = await adapter.readFile(ctx(), 'shop-app', 'README.md', 'main');
    expect(Buffer.from(readme!).toString()).toBe('# Shop\n');
    expect(await adapter.readFile(ctx(), 'shop-app', 'src', 'main')).toBeNull(); // a tree, not a file
    await expect(adapter.readFile(ctx(), 'shop-app', 'README.md', '--output=/tmp/x')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(adapter.readFile(ctx(), 'shop-app', '../x', 'main')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(adapter.readFile(ctx(), 'shop-app', 'README.md', 'no-such-branch')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('pages keep their place when new commits arrive between pages', async () => {
    const first = await adapter.listCommits(ctx(), 'team/api', 'main');
    expect(first.items.map((c) => c.message)).toEqual(['Change 3', 'Change 2', 'Change 1']);
    const shop = await adapter.listCommits(ctx(), 'shop-app', 'main');
    expect(shop.items[0]).toMatchObject({ message: 'Change 25', author: 'Dev <dev@example.test>' });
    // A new commit lands; the second page still continues where the first one ended.
    const repo = path.join(root, 'shop-app');
    writeFileSync(path.join(repo, 'new.txt'), 'x');
    git(repo, ['add', 'new.txt']);
    git(repo, [
      '-c',
      'user.name=Dev',
      '-c',
      'user.email=dev@example.test',
      'commit',
      '-q',
      '-m',
      'Late change',
    ]);
    const second = await adapter.listCommits(ctx(), 'shop-app', 'main', shop.nextCursor);
    expect(second.items[0]!.message).toBe('Change 15');
  });

  it('diffs two refs with renames and removals', async () => {
    const files = await adapter.diff(ctx(), 'shop-app', 'main~5', 'main~1');
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['src/file22.txt', 'src/file25.txt', 'src/file1.txt', 'README.md']),
    );
    expect(files.find((f) => f.path === 'src/file1.txt')?.status).toBe('removed');
  });

  it('never runs programs from repository configuration', async () => {
    await adapter.diff(ctx(), 'hostile', 'main~1', 'main');
    await adapter.readFile(ctx(), 'hostile', 'src/file2.txt', 'main');
    await adapter.listCommits(ctx(), 'hostile', 'main');
    expect(existsSync(marker)).toBe(false);
  });

  it('streams a plain tar archive of one commit', async () => {
    const stream = await adapter.streamArchive(ctx(), 'team/api', 'main');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const tar = Buffer.concat(chunks);
    expect(tar.length).toBeGreaterThan(1024);
    expect(tar.toString('latin1')).toContain('src/file3.txt');
    expect(tar.subarray(257, 262).toString()).toBe('ustar');
  });

  it('declares no clone token, branch or pull request capability', () => {
    expect(adapter.manifest()).toMatchObject({
      capabilities: ['repo.read@1', 'repo.commits.list@1', 'repo.diff.read@1'],
      authStrategies: ['none'],
      locator: 'local_path',
    });
  });
});
