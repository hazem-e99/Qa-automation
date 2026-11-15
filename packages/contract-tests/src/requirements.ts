import {
  ProviderError,
  type CapabilityId,
  type ConnectionContext,
  type ProviderErrorKind,
  type RequirementsSource,
  type SourceItemHeader,
} from '@qos/ports';
import { beforeEach, describe, expect, it } from 'vitest';
import { spyContext, type FixtureMode } from './repository.js';

export interface RequirementsHarness {
  readonly adapter: RequirementsSource;
  readonly mode: FixtureMode;
  readonly secret: string;
  readonly baseUrl?: string;
  readonly http?: ConnectionContext['http'];
  /** Binding config that selects at least two pages of items. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Changes one item at the source (a new revision), and returns its id. */
  readonly changeItem?: () => string;
  readonly injectFault?: (kind: ProviderErrorKind, retryAfterMs?: number) => void;
  reset?(): void;
}

async function all(h: RequirementsHarness, ctx: ConnectionContext, cursor?: string) {
  const seen: SourceItemHeader[] = [];
  let next = cursor;
  let resume: string | undefined;
  let pages = 0;
  do {
    const p = await h.adapter.listChanged(ctx, h.config, next);
    seen.push(...p.items);
    next = p.nextCursor;
    resume = p.resumeCursor ?? resume;
    pages++;
  } while (next && pages < 100);
  return { seen, resume, pages };
}

/**
 * Shared contract suite for the requirements family (doc 12 §4.2, §5): change listing that
 * resumes without gaps, normalized items (Markdown, no markup), change detection by revision,
 * error normalization and secret hygiene.
 */
export function requirementsContract(name: string, create: () => RequirementsHarness): void {
  const h = create();
  const declared = new Set<CapabilityId>(h.adapter.manifest().capabilities);

  describe(`RequirementsSource contract: ${name} (${h.mode})`, () => {
    let ctx: ConnectionContext;
    let lines: string[];
    beforeEach(() => {
      h.reset?.();
      ({ ctx, lines } = spyContext(h.secret, h.baseUrl, h.http));
    });

    it('declares the required requirements capabilities from the catalog', () => {
      const m = h.adapter.manifest();
      expect(m.family).toBe('requirements');
      expect(declared.has('requirements.list_changed@1')).toBe(true);
      expect(declared.has('requirements.get@1')).toBe(true);
      for (const c of m.capabilities) expect(c).toMatch(/^requirements\.[a-z_.]+@\d+$/);
    });

    it('tests the connection and reports a check for every declared capability', async () => {
      const result = await h.adapter.testConnection(ctx);
      expect(result.identity).toBeTruthy();
      expect(result.permissionChecks.map((c) => c.capability).sort()).toEqual([...declared].sort());
    });

    it('lists every item once across pages, oldest change first, and an incremental run sees nothing new', async () => {
      const { seen, resume, pages } = await all(h, ctx);
      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen.map((s) => s.externalId)).size).toBe(seen.length);
      const times = seen.map((s) => Date.parse(s.changedAt));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(resume).toBeTruthy();
      const again = await all(h, ctx, resume);
      // Sources may repeat the boundary item (same timestamp); nothing older comes back.
      expect(again.seen.length).toBeLessThanOrEqual(1);
    });

    it('reads an item normalized: Markdown text, no markup, a URL and a revision', async () => {
      const first = (await h.adapter.listChanged(ctx, h.config)).items[0]!;
      const item = await h.adapter.getItem(ctx, h.config, first.externalId);
      expect(item.externalId).toBe(first.externalId);
      expect(item.revision).toBe(first.revision);
      expect(item.title.trim()).not.toBe('');
      for (const text of [item.title, item.descriptionMarkdown, item.acceptanceCriteriaMarkdown ?? ''])
        expect(text).not.toMatch(/<\/?[a-z][^>]*>/i);
      expect(item.url).toMatch(/^https:\/\//);
      expect(Array.isArray(item.tags)).toBe(true);
    });

    it.skipIf(!h.changeItem)(
      `a change at the source is listed again with a new revision${h.changeItem ? '' : ' [skipped: no change hook in this mode]'}`,
      async () => {
        const { resume, seen } = await all(h, ctx);
        const id = h.changeItem!();
        const before = seen.find((s) => s.externalId === id)!.revision;
        const again = await all(h, ctx, resume);
        const changed = again.seen.find((s) => s.externalId === id);
        expect(changed).toBeDefined();
        expect(changed!.revision).not.toBe(before);
        expect((await h.adapter.getItem(ctx, h.config, id)).revision).toBe(changed!.revision);
      },
    );

    it('normalizes an unknown item to not_found', async () => {
      await expect(h.adapter.getItem(ctx, h.config, '999999999')).rejects.toMatchObject({
        kind: 'not_found',
      });
    });

    it.skipIf(!h.injectFault)(
      `maps provider failures to ProviderError kinds, with retryAfterMs on rate limits${h.injectFault ? '' : ' [skipped: no fault injection in this mode]'}`,
      async () => {
        for (const kind of ['auth_failed', 'permission_denied', 'unavailable'] as const) {
          h.injectFault!(kind);
          const err = await h.adapter.listChanged(ctx, h.config).catch((e: unknown) => e);
          expect(err, kind).toBeInstanceOf(ProviderError);
          expect((err as ProviderError).kind).toBe(kind);
        }
        h.injectFault!('rate_limited', 2000);
        await expect(h.adapter.listChanged(ctx, h.config)).rejects.toMatchObject({
          kind: 'rate_limited',
          details: { retryAfterMs: 2000 },
        });
      },
    );

    it('never puts the credential into logs or error messages', async () => {
      await h.adapter.testConnection(ctx);
      await h.adapter.getItem(ctx, h.config, '999999999').catch((e: Error) => lines.push(e.message));
      expect(lines.join('\n')).not.toContain(h.secret);
    });
  });
}
