import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238, HMAC-SHA1, 30-second steps, 6 digits) with base32 secrets (RFC 4648), the
 * parameters every authenticator app supports. Built on node:crypto; no extra dependency.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32-encoded (the size RFC 4226 recommends). */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export const stepAt = (now: Date): number => Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);

/** HOTP value for one counter (RFC 4226 §5.3). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totp = (secretB32: string, now: Date): string => hotp(base32Decode(secretB32), stepAt(now));

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the
 * matching step, or null. A step at or before `lastStep` is refused, so a code works only once.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  now: Date,
  lastStep: number | null = null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const current = stepAt(now);
  let matched: number | null = null;
  // Check every candidate, so the time taken does not depend on which one matched.
  for (const step of [current - 1, current, current + 1]) {
    const ok = timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code));
    if (ok && (lastStep === null || step > lastStep) && matched === null) matched = step;
  }
  return matched;
}

/** otpauth:// URI for authenticator apps (rendered as a QR code or typed in by hand). */
export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten recovery codes like `k7q2-9fzx-m3`, from an unambiguous alphabet. */
export function newRecoveryCodes(count = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: count }, () => {
    const s = [...randomBytes(10)].map((x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 10)}`;
  });
}
export const normalizeRecoveryCode = (code: string): string => code.trim().toLowerCase().replace(/\s/g, '');
