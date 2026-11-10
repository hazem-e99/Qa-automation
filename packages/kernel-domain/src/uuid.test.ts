import { describe, expect, it } from 'vitest';
import { isUuid, uuidv7 } from './uuid.js';
import { projectScope } from './scope.js';

describe('uuidv7', () => {
  it('has version 7 and the RFC variant', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });
  it('encodes the timestamp, so ids sort by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(parseInt(a.replaceAll('-', '').slice(0, 12), 16)).toBe(1_700_000_000_000);
  });
  it('is unique across many calls', () => {
    expect(new Set(Array.from({ length: 5000 }, () => uuidv7())).size).toBe(5000);
  });
});

describe('projectScope', () => {
  it('rejects non-UUID input', () => {
    expect(() => projectScope('x', uuidv7())).toThrow(TypeError);
    expect(projectScope(uuidv7(), uuidv7())).toMatchObject({});
  });
});
