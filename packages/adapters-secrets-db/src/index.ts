import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, secrets, type Db, type Tx } from '@qos/db';
import { uuidv7 } from '@qos/kernel-domain';
import {
  SecretNotFoundError,
  SecretUnreadableError,
  type NewSecret,
  type SecretMetadata,
  type SecretStore,
} from '@qos/ports';

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

export interface MasterKey {
  readonly id: string;
  readonly key: Buffer;
}

/** Non-secret identifier of a master key, stored next to each wrapped data key. */
const keyIdOf = (key: Buffer): string =>
  createHash('sha256').update('qos-master-key-id').update(key).digest('hex').slice(0, 16);

/** Accepts 32 bytes written as 64 hex characters or as base64. */
export function parseMasterKey(text: string): MasterKey {
  const value = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32)
    throw new MasterKeyError('master key must be 32 bytes (64 hex characters or base64)');
  return { id: keyIdOf(key), key };
}

/** Reads the master key from a file outside the repository. The error never contains key material. */
export function loadMasterKeyFile(path: string): MasterKey {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new MasterKeyError('master key file cannot be read');
  }
  return parseMasterKey(text);
}

export const generateMasterKey = (): string => randomBytes(32).toString('hex');

const KW_IV = Buffer.from('A6A6A6A6A6A6A6A6', 'hex'); // RFC 3394 default IV

/**
 * `db_envelope` SecretStore (doc 21 §6): each secret is encrypted with its own AES-256-GCM data
 * key; the data key is wrapped with the master key (AES-KW, RFC 3394). The secret's reference is
 * bound into the ciphertext as authenticated data, so rows cannot be swapped between secrets.
 */
export class DbEnvelopeSecretStore implements SecretStore<Tx> {
  private readonly keys: ReadonlyMap<string, Buffer>;

  /** `previous` keys can still decrypt; new and rotated secrets always use `current`. */
  constructor(
    private readonly db: Db,
    private readonly current: MasterKey,
    previous: readonly MasterKey[] = [],
  ) {
    this.keys = new Map([current, ...previous].map((k) => [k.id, k.key]));
  }

  async put(secret: NewSecret, tx?: Tx): Promise<string> {
    const ref = uuidv7();
    await (tx ?? this.db).insert(secrets).values({
      ref,
      ownerType: secret.ownerType,
      ownerId: secret.ownerId,
      purpose: secret.purpose,
      ...this.seal(ref, secret.value),
      createdAt: new Date(),
      expiresAt: secret.expiresAt ?? null,
    });
    return ref;
  }

  async get(ref: string): Promise<string> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.ref, ref));
    if (!row) throw new SecretNotFoundError();
    const master = this.keys.get(row.keyId);
    if (!master) throw new SecretUnreadableError('unknown_key');
    let dek: Buffer | null = null;
    try {
      const unwrap = createDecipheriv('id-aes256-wrap', master, KW_IV);
      dek = Buffer.concat([unwrap.update(Buffer.from(row.wrappedDek, 'base64')), unwrap.final()]);
      const blob = Buffer.from(row.ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', dek, blob.subarray(0, 12));
      decipher.setAAD(Buffer.from(ref));
      decipher.setAuthTag(blob.subarray(blob.length - 16));
      return Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      throw new SecretUnreadableError('integrity');
    } finally {
      dek?.fill(0);
    }
  }

  async rotate(ref: string, value: string, tx?: Tx): Promise<void> {
    const updated = await (tx ?? this.db)
      .update(secrets)
      .set({ ...this.seal(ref, value), rotatedAt: new Date() })
      .where(eq(secrets.ref, ref))
      .returning({ ref: secrets.ref });
    if (updated.length === 0) throw new SecretNotFoundError();
  }

  async delete(ref: string, tx?: Tx): Promise<void> {
    await (tx ?? this.db).delete(secrets).where(eq(secrets.ref, ref));
  }

  async describe(ref: string): Promise<SecretMetadata | null> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.ref, ref));
    if (!row) return null;
    return {
      ref: row.ref,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      purpose: row.purpose,
      createdAt: row.createdAt,
      rotatedAt: row.rotatedAt,
      expiresAt: row.expiresAt,
    };
  }

  /** Master key rotation: re-wraps every data key that is not under the current master key. */
  async rewrapAll(): Promise<number> {
    const rows = await this.db.select().from(secrets);
    let count = 0;
    for (const row of rows) {
      if (row.keyId === this.current.id) continue;
      const value = await this.get(row.ref);
      await this.db.update(secrets).set(this.seal(row.ref, value)).where(eq(secrets.ref, row.ref));
      count++;
    }
    return count;
  }

  private seal(ref: string, value: string): { ciphertext: string; wrappedDek: string; keyId: string } {
    if (typeof value !== 'string' || value.length === 0)
      throw new TypeError('secret value must be a non-empty string');
    const dek = randomBytes(32);
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dek, iv);
      cipher.setAAD(Buffer.from(ref));
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const wrap = createCipheriv('id-aes256-wrap', this.current.key, KW_IV);
      return {
        ciphertext: Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64'),
        wrappedDek: Buffer.concat([wrap.update(dek), wrap.final()]).toString('base64'),
        keyId: this.current.id,
      };
    } finally {
      dek.fill(0);
    }
  }
}
