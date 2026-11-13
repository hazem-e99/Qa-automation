import {
  CapabilityMissingError,
  ProviderError,
  type CapabilityId,
  type ConnectionContext,
  type ProviderErrorKind,
  type RepositoryProvider,
} from '@qos/ports';
import { beforeEach, describe, expect, it } from 'vitest';

export type FixtureMode = 'mock' | 'recorded' | 'live';

export interface RepositoryHarness {
  readonly adapter: RepositoryProvider;
  readonly mode: FixtureMode;
  /** A credential the adapter accepts. Used to check that it never reaches logs or errors. */
  readonly secret: string;
  /** A repository the credential can read, with at least two pages of commits. */
  readonly repoId: string;
  readonly baseUrl?: string;
  /** Recorded mode: serves recorded provider responses instead of the network. */
  readonly http?: ConnectionContext['http'];
  /** Optional fault injection. Suites that need it are skipped with a reason when absent. */
  readonly injectFault?: (kind: ProviderErrorKind, retryAfterMs?: number) => void;
  /** Restore the adapter's initial state between tests. */
  reset?(): void;
}

/** A logger spy: every line the adapter logs is kept for the redaction check. */
export function spyContext(
  secret: string,
  baseUrl?: string,
  http?: ConnectionContext['http'],
): { ctx: ConnectionContext; lines: string[] } {
  const lines: string[] = [];
  const log = (level: string) => (obj: object, msg?: string) =>
    lines.push(`${level} ${JSON.stringify(obj)} ${msg ?? ''}`);
  return {
    lines,
    ctx: {
      connectionId: 'contract-test',
      baseUrl: baseUrl ?? null,
      http: http ?? {
        request: async () => {
          throw new Error('no HTTP in mock mode');
        },
      },
      secret: async () => secret,
      log: { info: log('info'), warn: log('warn'), error: log('error') },
      now: () => new Date(),
    },
  };
}

/**
 * Shared contract suite for the source-control family (doc 12 §5). Every RepositoryProvider adapter
 * runs it. Capabilities the adapter does not declare become skipped tests whose name says why.
 */
export function repositoryContract(name: string, create: () => RepositoryHarness): void {
  const h = create();
  const declared = new Set<CapabilityId>(h.adapter.manifest().capabilities);
  const has = (c: CapabilityId) => declared.has(c);
  const skipReason = (c: CapabilityId) => (has(c) ? '' : ` [skipped: ${c} not declared]`);

  describe(`RepositoryProvider contract: ${name} (${h.mode})`, () => {
    let ctx: ConnectionContext;
    let lines: string[];
    beforeEach(() => {
      h.reset?.();
      ({ ctx, lines } = spyContext(h.secret, h.baseUrl, h.http));
    });

    it('declares only catalog capabilities of its family and a known auth strategy', () => {
      const m = h.adapter.manifest();
      expect(m.family).toBe('source_control');
      for (const c of m.capabilities) expect(c).toMatch(/^repo\.[a-z_.]+@\d+$/);
      expect(m.authStrategies.length).toBeGreaterThan(0);
    });

    it('tests the connection and reports a check for every declared capability', async () => {
      const result = await h.adapter.testConnection(ctx);
      expect(result.identity).toBeTruthy();
      expect(result.permissionChecks.map((c) => c.capability).sort()).toEqual([...declared].sort());
    });

    it.skipIf(!has('repo.read@1'))(
      `lists resources and reads a repository${skipReason('repo.read@1')}`,
      async () => {
        const first = await h.adapter.listResources(ctx, {});
        expect(first.items.length).toBeGreaterThan(0);
        const repo = await h.adapter.getRepo(ctx, h.repoId);
        expect(repo).toMatchObject({ id: h.repoId });
        expect(repo.defaultBranch).toBeTruthy();
        expect(
          await h.adapter.readFile(ctx, h.repoId, 'definitely/not/here.txt', repo.defaultBranch),
        ).toBeNull();
      },
    );

    it.skipIf(!has('repo.commits.list@1'))(
      `pages through commits with no duplicates and no gaps, and resumes from a cursor${skipReason('repo.commits.list@1')}`,
      async () => {
        const repo = await h.adapter.getRepo(ctx, h.repoId);
        const seen: string[] = [];
        const cursors: string[] = [];
        let cursor: string | undefined;
        do {
          const p = await h.adapter.listCommits(ctx, h.repoId, repo.defaultBranch, cursor);
          seen.push(...p.items.map((c) => c.sha));
          cursor = p.nextCursor;
          if (cursor) cursors.push(cursor);
        } while (cursor);
        expect(cursors.length).toBeGreaterThan(0);
        expect(new Set(seen).size).toBe(seen.length);
        // Resuming from the first cursor yields exactly the rest.
        const rest: string[] = [];
        cursor = cursors[0];
        while (cursor) {
          const p = await h.adapter.listCommits(ctx, h.repoId, repo.defaultBranch, cursor);
          rest.push(...p.items.map((c) => c.sha));
          cursor = p.nextCursor;
        }
        expect(rest).toEqual(seen.slice(seen.length - rest.length));
      },
    );

    it.skipIf(!has('repo.branch.create@1'))(
      `refuses branches outside qos/ and the default branch${skipReason('repo.branch.create@1')}`,
      async () => {
        const repo = await h.adapter.getRepo(ctx, h.repoId);
        for (const bad of ['feature/x', repo.defaultBranch, 'qosx/y']) {
          await expect(
            h.adapter.createBranch!(ctx, h.repoId, bad, repo.defaultBranch),
            bad,
          ).rejects.toMatchObject({
            kind: 'validation',
          });
        }
        const ok = await h.adapter.createBranch!(ctx, h.repoId, 'qos/contract-test', repo.defaultBranch);
        expect(ok.externalType).toBe('branch');
      },
    );

    it.skipIf(has('repo.branch.create@1'))(
      'an undeclared branch capability throws CapabilityMissingError',
      async () => {
        if (!h.adapter.createBranch) return;
        await expect(h.adapter.createBranch(ctx, h.repoId, 'qos/x', 'main')).rejects.toBeInstanceOf(
          CapabilityMissingError,
        );
      },
    );

    it.skipIf(!has('repo.clone_token.issue@1'))(
      `issues read-only, expiring clone credentials${skipReason('repo.clone_token.issue@1')}`,
      async () => {
        const cred = await h.adapter.issueCloneCredential(ctx, h.repoId, 600);
        expect(cred.readOnly).toBe(true);
        expect(new Date(cred.expiresAt).getTime()).toBeGreaterThan(Date.now());
        expect(new Date(cred.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1000);
        expect(cred.token).not.toBe(h.secret);
      },
    );

    it('normalizes unknown repositories to not_found', async () => {
      await expect(h.adapter.getRepo(ctx, 'no-such-repo-0')).rejects.toMatchObject({ kind: 'not_found' });
    });

    it.skipIf(!h.injectFault)(
      `maps provider failures to ProviderError kinds, with retryAfterMs on rate limits${h.injectFault ? '' : ' [skipped: no fault injection in this mode]'}`,
      async () => {
        for (const kind of ['auth_failed', 'permission_denied', 'unavailable', 'timeout'] as const) {
          h.injectFault!(kind);
          const err = await h.adapter.getRepo(ctx, h.repoId).catch((e: unknown) => e);
          expect(err, kind).toBeInstanceOf(ProviderError);
          expect((err as ProviderError).kind).toBe(kind);
        }
        h.injectFault!('rate_limited', 1500);
        await expect(h.adapter.getRepo(ctx, h.repoId)).rejects.toMatchObject({
          kind: 'rate_limited',
          details: { retryAfterMs: 1500 },
        });
      },
    );

    it('never puts the credential into logs or error messages', async () => {
      await h.adapter.testConnection(ctx);
      await h.adapter.getRepo(ctx, 'no-such-repo-0').catch((e: Error) => lines.push(e.message));
      expect(lines.join('\n')).not.toContain(h.secret);
    });
  });
}
