/**
 * SecretStore port (doc 21 §6). Callers keep only the reference; the value is decrypted in memory
 * at the moment of use. Values are never logged and never returned by any API.
 */
export interface SecretMetadata {
  readonly ref: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
  readonly expiresAt: Date | null;
}

export interface NewSecret {
  readonly ownerType: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly value: string;
  readonly expiresAt?: Date | null;
}

export interface SecretStore<TTx = unknown> {
  /** Stores a new secret and returns its reference. Pass `tx` to join the caller's transaction. */
  put(secret: NewSecret, tx?: TTx): Promise<string>;
  /** Throws SecretNotFoundError for an unknown reference. */
  get(ref: string): Promise<string>;
  /** Replaces the value; the old value is not recoverable afterwards. */
  rotate(ref: string, value: string, tx?: TTx): Promise<void>;
  delete(ref: string, tx?: TTx): Promise<void>;
  describe(ref: string): Promise<SecretMetadata | null>;
}

export class SecretNotFoundError extends Error {
  constructor() {
    super('secret not found');
    this.name = 'SecretNotFoundError';
  }
}
/** The stored secret cannot be decrypted: wrong master key or tampered data. */
export class SecretUnreadableError extends Error {
  constructor(readonly reason: 'unknown_key' | 'integrity') {
    super(`secret cannot be read (${reason})`);
    this.name = 'SecretUnreadableError';
  }
}
