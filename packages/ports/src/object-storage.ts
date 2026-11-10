/** ObjectStorage port (ADR-0011). The localfs adapter arrives with T-P1-12. */
export interface ObjectRef {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
}

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<ObjectRef>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
