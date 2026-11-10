import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat as fsStat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertValidObjectKey, ObjectNotFoundError, type ObjectRef, type ObjectStorage } from '@qos/ports';

/**
 * ObjectStorage on the local filesystem (ADR-0011, pilot default).
 * Layout under the root: `objects/<key>` for content and `meta/<sha256(key)>.json` for metadata.
 * Keys are validated by the port's rule and additionally checked to resolve inside the root.
 */
export class LocalFsObjectStorage implements ObjectStorage {
  private readonly objects: string;
  private readonly meta: string;
  private readonly tmp: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    const abs = path.resolve(root);
    this.objects = path.join(abs, 'objects');
    this.meta = path.join(abs, 'meta');
    this.tmp = path.join(abs, 'tmp');
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<ObjectRef> {
    const file = this.objectPath(key);
    const ref: ObjectRef = {
      key,
      size: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
      contentType,
    };
    // Writers of one key run one after another, so content and metadata always match.
    return this.exclusive(key, async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await mkdir(this.meta, { recursive: true });
      await mkdir(this.tmp, { recursive: true });
      // Write to a temp file in the same volume, then rename: readers never see a partial object.
      await this.replace(file, body);
      await this.replace(this.metaPath(key), JSON.stringify(ref));
      return ref;
    });
  }

  private async replace(target: string, data: Uint8Array | string): Promise<void> {
    const staging = path.join(this.tmp, randomUUID());
    try {
      await writeFile(staging, data, { flag: 'wx' });
      // Windows refuses a rename while another process has the target open; retry briefly.
      for (let attempt = 1; ; attempt++) {
        try {
          await rename(staging, target);
          return;
        } catch (e) {
          const code = (e as { code?: string } | null)?.code;
          if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
          await new Promise((r) => setTimeout(r, 15 * attempt));
        }
      }
    } finally {
      await rm(staging, { force: true });
    }
  }

  private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.objectPath(key)));
    } catch (e) {
      if (isMissing(e)) throw new ObjectNotFoundError(key);
      throw e;
    }
  }

  async stat(key: string): Promise<ObjectRef | null> {
    const file = this.objectPath(key);
    try {
      const info = await fsStat(file);
      if (!info.isFile()) return null;
      try {
        const ref = JSON.parse(await readFile(this.metaPath(key), 'utf8')) as ObjectRef;
        if (ref.key === key && ref.size === info.size) return ref;
      } catch {
        // Missing or stale metadata: fall through and rebuild it from the content.
      }
      const body = await readFile(file);
      return {
        key,
        size: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
        contentType: 'application/octet-stream',
      };
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.objectPath(key), { force: true });
    await rm(this.metaPath(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  private objectPath(key: string): string {
    assertValidObjectKey(key);
    const file = path.resolve(this.objects, ...key.split('/'));
    // Defence in depth: the resolved path must stay inside the objects directory.
    if (!file.startsWith(this.objects + path.sep)) throw new Error('object key escapes the storage root');
    return file;
  }

  private metaPath(key: string): string {
    return path.join(this.meta, `${createHash('sha256').update(key).digest('hex')}.json`);
  }
}

const isMissing = (e: unknown): boolean => {
  const code = (e as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
};
