/** ObjectStorage port (ADR-0011). Keys are logical paths chosen by the caller, never host paths. */
export interface ObjectRef {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
}

export interface ObjectStorage {
  /** Stores the object, replacing any existing one with the same key. The write is atomic. */
  put(key: string, body: Uint8Array, contentType: string): Promise<ObjectRef>;
  /** Throws ObjectNotFoundError when the key does not exist. */
  get(key: string): Promise<Uint8Array>;
  stat(key: string): Promise<ObjectRef | null>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super('object not found');
    this.name = 'ObjectNotFoundError';
  }
}
export class InvalidObjectKeyError extends Error {
  constructor() {
    super('invalid object key');
    this.name = 'InvalidObjectKeyError';
  }
}

/**
 * Object keys: lower-case segments separated by "/", no "." or ".." segments, no backslashes,
 * no leading or trailing slash. Adapters must reject anything else.
 */
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;
export function assertValidObjectKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) throw new InvalidObjectKeyError();
  for (const segment of key.split('/')) {
    if (!SEGMENT.test(segment) || segment.endsWith('.') || WINDOWS_DEVICE.test(segment)) {
      throw new InvalidObjectKeyError();
    }
  }
}
