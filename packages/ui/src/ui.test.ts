import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cn, directionOf, isTheme } from './index.js';

describe('ui helpers', () => {
  it('joins class names and resolves direction and themes', () => {
    expect(cn('a', false, null, 'b', undefined, '')).toBe('a b');
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('neon')).toBe(false);
  });
});

describe('tokens', () => {
  const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
  const vars = (block: string) => [...block.matchAll(/(--qos-[a-z-]+):/g)].map((m) => m[1]).sort();
  const colours = (names: (string | undefined)[]) =>
    names.filter((n) => !/radius|width|height|font/.test(n ?? ''));

  it('dark themes redefine every colour token of the light theme', () => {
    const [light, media, explicit] = css.split(
      /@media \(prefers-color-scheme: dark\)|:root\[data-theme='dark'\]/,
    );
    const expected = colours(vars(light!));
    expect(expected.length).toBeGreaterThan(8);
    expect(vars(media!)).toEqual(expected);
    expect(vars(explicit!)).toEqual(expected);
  });
});
