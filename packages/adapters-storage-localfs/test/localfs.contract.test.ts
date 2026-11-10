import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { objectStorageContract } from '@qos/contract-tests';
import { describe, expect, it } from 'vitest';
import { LocalFsObjectStorage } from '../src/index.js';

objectStorageContract('localfs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qos-storage-'));
  return {
    storage: new LocalFsObjectStorage(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

describe('localfs specifics', () => {
  it('writes nothing outside its root and leaves no temp files behind', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'qos-storage-parent-'));
    try {
      const storage = new LocalFsObjectStorage(path.join(parent, 'root'));
      await storage.put('a/b.txt', new TextEncoder().encode('x'), 'text/plain');
      await expect(storage.put('../outside.txt', new Uint8Array(1), 'text/plain')).rejects.toThrow();
      expect(await readdir(parent)).toEqual(['root']);
      expect(await readdir(path.join(parent, 'root', 'tmp'))).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
