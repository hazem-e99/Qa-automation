import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from './rate-limit.js';

describe('TokenBucketLimiter', () => {
  it('allows a burst, then refuses with a retry hint, then refills over time', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ ratePerSecond: 2, burst: 3, now: () => now });
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, true]);
    const refused = limiter.take('a');
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 1, remaining: 0 });
    now += 500; // one token back at 2/s
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    now += 60_000; // never exceeds the burst size
    expect([1, 2, 3, 4].map(() => limiter.take('a').allowed)).toEqual([true, true, true, false]);
  });

  it('keeps keys independent and bounds memory', () => {
    const limiter = new TokenBucketLimiter({ ratePerSecond: 1, burst: 1, maxKeys: 3, now: () => 0 });
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('b').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    for (const k of ['c', 'd', 'e']) limiter.take(k);
    expect(limiter.size).toBe(3);
  });

  it('rejects nonsensical options', () => {
    expect(() => new TokenBucketLimiter({ ratePerSecond: 0, burst: 1 })).toThrow(RangeError);
    expect(() => new TokenBucketLimiter({ ratePerSecond: 1, burst: 0 })).toThrow(RangeError);
  });
});
