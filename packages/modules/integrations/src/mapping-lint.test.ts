import { describe, expect, it } from 'vitest';
import { lintMapping, suggestMapping } from './mapping-lint.js';

const codes = (r: ReturnType<typeof lintMapping>) =>
  r.issues.map((i) => `${i.severity}:${i.code}:${i.value}`).sort();

describe('mapping lint (M03-FR-13)', () => {
  it('a status mapping that misses a discovered state is an error (BR-M03-6)', () => {
    const r = lintMapping(
      'status',
      [
        { external: 'New', canonical: 'open' },
        { external: 'Resolved', canonical: 'resolved' },
        { external: 'Closed', canonical: 'closed' },
      ],
      ['New', 'Active', 'Resolved', 'Closed'],
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['error:unmapped_external:Active']);
  });

  it('flags duplicates, unknown canonical values, stale and unreachable ones', () => {
    const r = lintMapping(
      'status',
      [
        { external: 'New', canonical: 'open' },
        { external: 'New', canonical: 'in_progress' },
        { external: 'Gone', canonical: 'closed' },
        { external: 'Done', canonical: 'finished' },
      ],
      ['New', 'Done'],
    );
    expect(codes(r)).toEqual([
      'error:duplicate_external:New',
      'error:unknown_canonical:finished',
      'warning:stale_external:Gone',
      'warning:unreachable_canonical:resolved',
    ]);
  });

  it('without discovery, only structural checks run', () => {
    const r = lintMapping('status', [{ external: 'New', canonical: 'open' }], null);
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual([
      'warning:unreachable_canonical:closed',
      'warning:unreachable_canonical:resolved',
    ]);
  });

  it('severity needs every canonical value; unmapped external values only warn', () => {
    const r = lintMapping(
      'severity',
      [{ external: '1 - Critical', canonical: 'S1' }],
      ['1 - Critical', '2 - High'],
    );
    expect(codes(r)).toEqual([
      'error:unmapped_canonical:S2',
      'error:unmapped_canonical:S3',
      'error:unmapped_canonical:S4',
      'warning:unmapped_external:2 - High',
    ]);
  });

  it('the bug type maps to exactly one external type', () => {
    expect(lintMapping('type', [], null).ok).toBe(false);
    expect(
      codes(
        lintMapping(
          'type',
          [
            { external: 'Bug', canonical: 'bug' },
            { external: 'Defect', canonical: 'bug' },
          ],
          null,
        ),
      ),
    ).toEqual(['error:bug_type_ambiguous:bug']);
    expect(lintMapping('type', [{ external: 'Bug', canonical: 'bug' }], ['Bug', 'Task']).ok).toBe(true);
  });

  it('suggests a mapping that lints clean for a typical process', () => {
    const states = ['New', 'Active', 'Resolved', 'Closed', 'Removed'];
    const cats = {
      New: 'proposed',
      Active: 'in_progress',
      Resolved: 'resolved',
      Closed: 'completed',
      Removed: 'removed',
    };
    const s = suggestMapping('status', states, cats);
    expect(lintMapping('status', s, states)).toEqual({ ok: true, issues: [] });
    const sev = ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'];
    expect(lintMapping('severity', suggestMapping('severity', sev), sev).ok).toBe(true);
    expect(suggestMapping('type', ['Task', 'Bug'])).toEqual([{ external: 'Bug', canonical: 'bug' }]);
  });
});
