import { describe, expect, it } from 'vitest';
import { auditHash, canonicalJson, GENESIS_HASH } from './audit.js';

describe('audit hashing', () => {
  it('canonical JSON ignores key order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
  });
  it('changes when the previous hash or any field changes', () => {
    const row = { id: '1', action: 'a' };
    const h = auditHash(GENESIS_HASH, row);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(auditHash('f'.repeat(64), row)).not.toBe(h);
    expect(auditHash(GENESIS_HASH, { ...row, action: 'b' })).not.toBe(h);
  });
});
