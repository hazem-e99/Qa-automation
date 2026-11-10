import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring links to stored objects (T-P1-12). The signature covers the object key and the
 * expiry, so a link cannot be reused for another object or extended. Links are bearer tokens:
 * keep lifetimes short.
 */
const mac = (secret: string, key: string, exp: number): string =>
  createHmac('sha256', secret).update(`${exp}\n${key}`).digest('base64url');

export function signFilePath(
  secret: string,
  key: string,
  ttlSeconds: number,
  now: number = Date.now(),
): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `/files/${path}?exp=${exp}&sig=${mac(secret, key, exp)}`;
}

export type FileLinkCheck = 'ok' | 'expired' | 'invalid';

export function verifyFileLink(
  secret: string,
  key: string,
  exp: unknown,
  sig: unknown,
  now: number = Date.now(),
): FileLinkCheck {
  if (typeof exp !== 'string' || typeof sig !== 'string' || !/^\d{1,12}$/.test(exp)) return 'invalid';
  const expected = Buffer.from(mac(secret, key, Number(exp)));
  const given = Buffer.from(sig);
  // Compare before checking expiry so an attacker learns nothing about valid signatures from timing.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  return Number(exp) * 1000 < now ? 'expired' : 'ok';
}
