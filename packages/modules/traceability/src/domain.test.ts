import { describe, expect, it } from 'vitest';
import { coverageOf, isLinkType, linkShapeError, wouldCycle } from './domain.js';

const a = '00000000-0000-7000-8000-00000000000a';
const b = '00000000-0000-7000-8000-00000000000b';

describe('traceability graph rules (T-P3-12)', () => {
  it('allows only the documented endpoint types per link type', () => {
    expect(
      linkShapeError('verifies', { type: 'test_case', id: a }, { type: 'requirement', id: b }),
    ).toBeNull();
    expect(linkShapeError('verifies', { type: 'requirement', id: a }, { type: 'test_case', id: b })).toBe(
      'trace.link_shape_invalid',
    );
    expect(linkShapeError('child_of', { type: 'requirement', id: a }, { type: 'requirement', id: a })).toBe(
      'trace.self_link',
    );
    expect(linkShapeError('blocks', { type: 'requirement', id: a }, { type: 'requirement', id: b })).toBe(
      'trace.link_type_invalid',
    );
    expect(isLinkType('toString')).toBe(false);
  });

  it('derives coverage from live verifying links (M04-FR-17)', () => {
    expect(coverageOf([])).toBe('uncovered');
    expect(coverageOf([{ status: 'removed' }])).toBe('uncovered');
    expect(coverageOf([{ status: 'active' }])).toBe('covered_manual');
    expect(coverageOf([{ status: 'active', automated: true }])).toBe('covered_automated');
    expect(coverageOf([{ status: 'active', automated: true }, { status: 'active' }])).toBe('covered_both');
    expect(coverageOf([{ status: 'active', automated: true, failing: true }, { status: 'active' }])).toBe(
      'failing',
    );
  });

  it('detects hierarchy cycles', () => {
    const parents = new Map([
      ['c', ['b']],
      ['b', ['a']],
    ]);
    expect(wouldCycle('a', 'c', parents)).toBe(true);
    expect(wouldCycle('d', 'c', parents)).toBe(false);
    expect(wouldCycle('a', 'a', parents)).toBe(true);
  });
});
