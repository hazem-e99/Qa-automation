import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { createApiApp } from '../dist/bootstrap.js';

let t: TestDatabase;
let dir: string;
const env = (extra: Record<string, string>) => ({
  DATABASE_URL: t.url,
  LOG_LEVEL: 'silent',
  WEBHOOK_PORT: '0',
  ...extra,
});

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-key-'));
}, 180_000);
afterAll(async () => {
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('master key at start-up (M14: no plaintext fallback)', () => {
  it('refuses to start in production without a master key file', async () => {
    await expect(createApiApp(env({ NODE_ENV: 'production', API_PORT: '39061' }))).rejects.toThrow(
      /QOS_MASTER_KEY_FILE: required in production/,
    );
  });

  it('refuses a missing or malformed key file, without echoing its content', async () => {
    const missing = path.join(dir, 'none.key');
    await expect(
      createApiApp(env({ NODE_ENV: 'production', API_PORT: '39062', QOS_MASTER_KEY_FILE: missing })),
    ).rejects.toThrow('master key file cannot be read');
    const bad = path.join(dir, 'bad.key');
    await writeFile(bad, 'this-is-not-a-valid-key-material');
    const err = await createApiApp(
      env({ NODE_ENV: 'test', API_PORT: '39063', QOS_MASTER_KEY_FILE: bad }),
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('master key must be 32 bytes');
    expect((err as Error).message).not.toContain('valid-key-material');
  });

  it('starts with a valid key and exposes a working secret store', async () => {
    const file = path.join(dir, 'master.key');
    await writeFile(file, generateMasterKey());
    const api = await createApiApp(
      env({ NODE_ENV: 'production', API_PORT: '39064', QOS_MASTER_KEY_FILE: file }),
    );
    try {
      expect(api.secrets).not.toBeNull();
      const ref = await api.secrets!.put({
        ownerType: 'test',
        ownerId: 't',
        purpose: 'p',
        value: 'top-secret-value',
      });
      expect(await api.secrets!.get(ref)).toBe('top-secret-value');
    } finally {
      await api.close();
    }
  });

  it('outside production it may start without a key, and then has no secret store', async () => {
    const api = await createApiApp(env({ NODE_ENV: 'test', API_PORT: '39065' }));
    try {
      expect(api.secrets).toBeNull();
    } finally {
      await api.close();
    }
  });
});
