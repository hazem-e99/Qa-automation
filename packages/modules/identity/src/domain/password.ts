import { DomainError } from '@qos/kernel-domain';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** A tiny built-in deny list. The optional breached-password list (M13 §12) is a later addition. */
const COMMON = new Set([
  'password1234',
  '123456789012',
  'qwertyuiopas',
  'adminadminadmin',
  'changemechangeme',
]);

/** Length-based policy (M13: minimum 12). No composition rules: length beats complexity. */
export function assertPasswordAcceptable(password: string, context: readonly string[] = []): void {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new DomainError('password.too_short', { min: PASSWORD_MIN_LENGTH });
  }
  if (password.length > PASSWORD_MAX_LENGTH)
    throw new DomainError('password.too_long', { max: PASSWORD_MAX_LENGTH });
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) throw new DomainError('password.too_common');
  // The password must not simply be the email address or its name part.
  for (const c of context) {
    const v = c.toLowerCase();
    if (v.length >= 4 && (lower === v || lower === v.split('@')[0]))
      throw new DomainError('password.too_common');
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export function normalizeEmail(email: string): string {
  const v = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(v) || v.length > 320) throw new DomainError('email.invalid');
  return v;
}
