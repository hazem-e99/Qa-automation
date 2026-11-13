import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API token format and scopes (M13-FR-04, BR-M13-6).
 *
 * Token: `qos_<prefix>_<secret>`. The prefix (12 lowercase base32 characters) is stored to find
 * the row and to show the token in lists; the hash is HMAC-SHA256(pepper, whole token).
 */
export const TOKEN_SCOPES = {
  'projects:read': 'Read projects the token is restricted to',
  'automation:fire': 'Fire automation rules (P7)',
  'runs:trigger': 'Trigger test runs (P6)',
  'results:write': 'Report run results (P6)',
} as const;
export type TokenScope = keyof typeof TOKEN_SCOPES;
export const isTokenScope = (v: unknown): v is TokenScope => typeof v === 'string' && v in TOKEN_SCOPES;
/** Upper bound on token lifetime (M13-FR-04). */
export const TOKEN_MAX_DAYS = 365;

const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const TOKEN_RE = /^qos_([a-z2-7]{12})_([A-Za-z0-9_-]{43})$/;

export function newApiToken(): { token: string; prefix: string } {
  const prefix = [...randomBytes(12)].map((b) => PREFIX_ALPHABET[b & 31]).join('');
  const token = `qos_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, prefix };
}

export const parseApiToken = (raw: string): { prefix: string } | null => {
  const m = TOKEN_RE.exec(raw);
  return m ? { prefix: m[1]! } : null;
};

export const hashApiToken = (pepper: string, token: string): string =>
  createHmac('sha256', pepper).update(token).digest('hex');

export function apiTokenMatches(pepper: string, token: string, storedHash: string): boolean {
  const a = Buffer.from(hashApiToken(pepper, token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
