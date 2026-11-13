import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

type Tree = { [k: string]: string | Tree };
const flatten = (tree: Tree, prefix = ''): Record<string, string> =>
  Object.entries(tree).reduce<Record<string, string>>((out, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? { ...out, [key]: v } : { ...out, ...flatten(v, key) };
  }, {});
/** Top-level ICU arguments of a message, e.g. "{count, plural, …}" → count. */
const args = (msg: string) => new Set([...msg.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)].map((m) => m[1]));

describe('translations', () => {
  const E = flatten(en as Tree);
  const A = flatten(ar as Tree);

  it('English and Arabic have the same keys', () => {
    expect(Object.keys(A).sort()).toEqual(Object.keys(E).sort());
  });

  it('every message uses the same placeholders in both languages', () => {
    for (const key of Object.keys(E)) {
      expect([...args(A[key] ?? '')].sort(), key).toEqual([...args(E[key]!)].sort());
    }
  });

  it('no message is empty', () => {
    for (const [k, v] of Object.entries({ ...E, ...A })) expect(v.trim().length, k).toBeGreaterThan(0);
  });
});
