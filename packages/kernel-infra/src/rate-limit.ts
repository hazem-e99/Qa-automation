/**
 * In-memory token bucket (doc 21: Redis is not required at pilot scale). One bucket per key.
 * State is per process, so with several API instances the effective limit is multiplied.
 */
export interface RateLimitOptions {
  /** Tokens added per second. */
  readonly ratePerSecond: number;
  /** Bucket size: how many requests may arrive at once. */
  readonly burst: number;
  /** Upper bound on tracked keys; the least recently used are dropped beyond it. */
  readonly maxKeys?: number;
  readonly now?: () => number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until one token is available again (0 when allowed). */
  readonly retryAfterSeconds: number;
  readonly remaining: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;

  constructor(private readonly opts: RateLimitOptions) {
    if (!(opts.ratePerSecond > 0) || !(opts.burst >= 1)) throw new RangeError('invalid rate limit options');
    this.now = opts.now ?? Date.now;
  }

  take(key: string, cost = 1): RateLimitDecision {
    const now = this.now();
    const { ratePerSecond, burst } = this.opts;
    const b = this.buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * ratePerSecond);
    b.at = now;
    // Re-insert so the Map keeps keys in least-recently-used order.
    this.buckets.delete(key);
    this.buckets.set(key, b);
    if (this.buckets.size > (this.opts.maxKeys ?? 10_000)) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(b.tokens) };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((cost - b.tokens) / ratePerSecond)),
      remaining: 0,
    };
  }

  get size(): number {
    return this.buckets.size;
  }
}
