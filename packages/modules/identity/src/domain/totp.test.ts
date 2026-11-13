import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, newRecoveryCodes, otpauthUri, totp, verifyTotp } from './totp.js';

// RFC 6238 Appendix B (SHA-1 seed "12345678901234567890"). The RFC lists 8 digits; a 6-digit
// generator yields the last 6 of them for the same counter.
const SEED = Buffer.from('12345678901234567890');
const SECRET = base32Encode(SEED);

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ];
    for (const [t, expected] of vectors) {
      expect(hotp(SEED, Math.floor(t / 30), 8)).toBe(expected);
      expect(totp(SECRET, new Date(t * 1000))).toBe(expected.slice(2));
    }
  });

  it('round-trips base32 and matches RFC 4648 examples', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb-oi======').toString()).toBe('foobar');
    expect(base32Decode(SECRET).equals(SEED)).toBe(true);
  });

  it('accepts one step of drift either way and refuses replays', () => {
    const now = new Date(1_700_000_000_000);
    const code = totp(SECRET, now);
    const step = verifyTotp(SECRET, code, now);
    expect(step).not.toBeNull();
    expect(verifyTotp(SECRET, code, new Date(now.getTime() + 30_000))).toBe(step);
    expect(verifyTotp(SECRET, code, new Date(now.getTime() + 90_000))).toBeNull();
    expect(verifyTotp(SECRET, code, now, step)).toBeNull(); // already used
    expect(verifyTotp(SECRET, '12345', now)).toBeNull();
    expect(verifyTotp(SECRET, 'abcdef', now)).toBeNull();
  });

  it('builds an otpauth URI and distinct recovery codes', () => {
    const uri = otpauthUri('QualityOS', 'a@example.test', SECRET);
    expect(uri.startsWith('otpauth://totp/QualityOS%3Aa%40example.test?')).toBe(true);
    expect(new URL(uri).searchParams.get('secret')).toBe(SECRET);
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{2}$/);
  });
});
