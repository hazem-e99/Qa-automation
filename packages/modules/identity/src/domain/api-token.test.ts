import { describe, expect, it } from 'vitest';
import { apiTokenMatches, hashApiToken, newApiToken, parseApiToken } from './api-token.js';

describe('API token format', () => {
  it('has the qos_ prefix, parses back to its prefix, and hashes with the pepper', () => {
    const { token, prefix } = newApiToken();
    expect(token).toMatch(/^qos_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/);
    expect(parseApiToken(token)).toEqual({ prefix });
    const hash = hashApiToken('pepper-a', token);
    expect(apiTokenMatches('pepper-a', token, hash)).toBe(true);
    expect(apiTokenMatches('pepper-b', token, hash)).toBe(false);
    expect(apiTokenMatches('pepper-a', `${token}x`, hash)).toBe(false);
  });

  it('rejects anything that is not a token', () => {
    const upper = `qos_ABCDEFGHIJKL_${'a'.repeat(43)}`;
    for (const bad of ['', 'qos_', 'ghp_abc', upper, 'qos_abc_def']) {
      expect(parseApiToken(bad)).toBeNull();
    }
  });
});
