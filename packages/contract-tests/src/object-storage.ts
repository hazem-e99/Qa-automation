import { createHash } from 'node:crypto';
import { InvalidObjectKeyError, ObjectNotFoundError, type ObjectStorage } from '@qos/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

export interface ObjectStorageHarness {
  readonly storage: ObjectStorage;
  cleanup(): Promise<void>;
}

/**
 * Shared contract suite for the ObjectStorage port (doc 12). Every storage adapter runs it:
 *   objectStorageContract('localfs', async () => ({ storage, cleanup }))
 */
export function objectStorageContract(name: string, create: () => Promise<ObjectStorageHarness>): void {
  describe(`ObjectStorage contract: ${name}`, () => {
    let h: ObjectStorageHarness;
    beforeAll(async () => {
      h = await create();
    });
    afterAll(async () => {
      await h?.cleanup();
    });
    const bytes = (s: string) => new TextEncoder().encode(s);
    const text = (b: Uint8Array) => new TextDecoder().decode(b);

    it('stores and returns bytes exactly, with size, hash and content type', async () => {
      const body = new Uint8Array([0, 255, 10, 13, 0, 128, 7]);
      const ref = await h.storage.put('runs/r1/trace.bin', body, 'application/octet-stream');
      expect(ref).toEqual({
        key: 'runs/r1/trace.bin',
        size: 7,
        sha256: createHash('sha256').update(body).digest('hex'),
        contentType: 'application/octet-stream',
      });
      expect([...(await h.storage.get('runs/r1/trace.bin'))]).toEqual([...body]);
      expect(await h.storage.stat('runs/r1/trace.bin')).toEqual(ref);
      expect(await h.storage.exists('runs/r1/trace.bin')).toBe(true);
    });

    it('keeps non-ASCII content intact', async () => {
      await h.storage.put('docs/ar.txt', bytes('صفحة الاختبار — test'), 'text/plain; charset=utf-8');
      expect(text(await h.storage.get('docs/ar.txt'))).toBe('صفحة الاختبار — test');
    });

    it('overwrites an existing key and reports the new metadata', async () => {
      await h.storage.put('a/over.txt', bytes('first'), 'text/plain');
      const second = await h.storage.put('a/over.txt', bytes('second!'), 'text/markdown');
      expect(text(await h.storage.get('a/over.txt'))).toBe('second!');
      expect(await h.storage.stat('a/over.txt')).toEqual(second);
      expect(second.contentType).toBe('text/markdown');
    });

    it('reports missing objects consistently', async () => {
      await expect(h.storage.get('missing/none.txt')).rejects.toBeInstanceOf(ObjectNotFoundError);
      expect(await h.storage.stat('missing/none.txt')).toBeNull();
      expect(await h.storage.exists('missing/none.txt')).toBe(false);
      // A key that is only a prefix of stored objects is not an object.
      await h.storage.put('prefix/child.txt', bytes('x'), 'text/plain');
      expect(await h.storage.exists('prefix')).toBe(false);
      await expect(h.storage.get('prefix')).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('delete removes the object and is idempotent', async () => {
      await h.storage.put('a/del.txt', bytes('x'), 'text/plain');
      await h.storage.delete('a/del.txt');
      await h.storage.delete('a/del.txt');
      expect(await h.storage.exists('a/del.txt')).toBe(false);
    });

    it('rejects keys that could leave the storage root or confuse path handling', async () => {
      for (const key of [
        '../escape.txt',
        'a/../../escape.txt',
        '/abs.txt',
        'a//b.txt',
        'a/./b.txt',
        'a\\b.txt',
        'C:/x.txt',
        '',
        'a/',
        'UPPER.txt',
        'a/b.',
        '.hidden',
        'a/..',
        'sp ace.txt',
        'nul\u0000.txt',
        'x'.repeat(513),
        'a/nul',
        'con.txt',
        'a/com1.log',
      ]) {
        await expect(
          h.storage.put(key, bytes('x'), 'text/plain'),
          JSON.stringify(key),
        ).rejects.toBeInstanceOf(InvalidObjectKeyError);
        await expect(h.storage.get(key), JSON.stringify(key)).rejects.toBeInstanceOf(InvalidObjectKeyError);
      }
    });

    it('handles an empty object and a larger one', async () => {
      const empty = await h.storage.put('a/empty.bin', new Uint8Array(0), 'application/octet-stream');
      expect(empty.size).toBe(0);
      expect((await h.storage.get('a/empty.bin')).byteLength).toBe(0);
      const big = new Uint8Array(2 * 1024 * 1024).fill(7);
      const ref = await h.storage.put('a/big.bin', big, 'application/octet-stream');
      expect(ref.size).toBe(big.byteLength);
      expect((await h.storage.get('a/big.bin')).byteLength).toBe(big.byteLength);
    });

    it('concurrent writes to one key leave one complete object', async () => {
      const variants = Array.from({ length: 8 }, (_, i) => bytes(String(i).repeat(50_000)));
      await Promise.all(variants.map((v) => h.storage.put('a/race.txt', v, 'text/plain')));
      const got = text(await h.storage.get('a/race.txt'));
      expect(got).toHaveLength(50_000);
      expect(new Set(got).size).toBe(1);
    });
  });
}
