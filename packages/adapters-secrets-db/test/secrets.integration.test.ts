import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { SecretNotFoundError, SecretUnreadableError } from '@qos/ports';
import {
  DbEnvelopeSecretStore,
  generateMasterKey,
  loadMasterKeyFile,
  MasterKeyError,
  parseMasterKey,
} from '../src/index.js';

let t: TestDatabase;
let store: DbEnvelopeSecretStore;
const master = parseMasterKey(generateMasterKey());
const SECRET = 'ghp_exampleTokenValue0123456789abcdefXYZ';
const owner = { ownerType: 'connection', ownerId: 'c1', purpose: 'api_token' };

beforeAll(async () => {
  t = await startTestDatabase();
  store = new DbEnvelopeSecretStore(t.db, master);
}, 180_000);
afterAll(async () => {
  await t?.stop();
});

describe('master key handling', () => {
  it('accepts 32 bytes as hex or base64 and rejects anything else without echoing it', async () => {
    const hex = generateMasterKey();
    expect(parseMasterKey(hex).key).toHaveLength(32);
    expect(parseMasterKey(Buffer.from(hex, 'hex').toString('base64')).id).toBe(parseMasterKey(hex).id);
    for (const bad of ['', 'too-short', 'a'.repeat(63)]) {
      expect(() => parseMasterKey(bad), bad).toThrow(MasterKeyError);
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'qos-key-'));
    try {
      await writeFile(path.join(dir, 'k'), `${hex}\n`);
      expect(loadMasterKeyFile(path.join(dir, 'k')).id).toBe(parseMasterKey(hex).id);
      expect(() => loadMasterKeyFile(path.join(dir, 'missing'))).toThrow('master key file cannot be read');
      await writeFile(path.join(dir, 'bad'), 'not-a-key-but-secret-looking');
      const err = (() => {
        try {
          loadMasterKeyFile(path.join(dir, 'bad'));
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err?.message).not.toContain('secret-looking');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('db_envelope secret store', () => {
  it('round-trips a value and keeps nothing readable in the database', async () => {
    const ref = await store.put({ ...owner, value: SECRET });
    expect(await store.get(ref)).toBe(SECRET);
    const dump = JSON.stringify((await t.pool.query('select * from governance.secrets')).rows);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(Buffer.from(SECRET).toString('base64'));
    expect(await store.describe(ref)).toMatchObject({ ref, purpose: 'api_token', rotatedAt: null });
    expect(JSON.stringify(await store.describe(ref))).not.toContain(SECRET);
  });

  it('uses a fresh data key and nonce for every secret, even for equal values', async () => {
    const a = await store.put({ ...owner, value: SECRET });
    const b = await store.put({ ...owner, value: SECRET });
    const rows = (
      await t.pool.query('select ciphertext, wrapped_dek from governance.secrets where ref = any($1)', [
        [a, b],
      ])
    ).rows;
    expect(rows[0].ciphertext).not.toBe(rows[1].ciphertext);
    expect(rows[0].wrapped_dek).not.toBe(rows[1].wrapped_dek);
  });

  it('keeps unicode values intact and rejects empty ones', async () => {
    const ref = await store.put({ ...owner, value: 'كلمة سر — pässwörd 🔑' });
    expect(await store.get(ref)).toBe('كلمة سر — pässwörd 🔑');
    await expect(store.put({ ...owner, value: '' })).rejects.toThrow(TypeError);
  });

  it('detects tampering and rows swapped between secrets', async () => {
    const a = await store.put({ ...owner, value: 'value-of-a' });
    const b = await store.put({ ...owner, value: 'value-of-b' });
    await t.pool.query(
      `update governance.secrets x set ciphertext = y.ciphertext, wrapped_dek = y.wrapped_dek
       from governance.secrets y where x.ref = $1 and y.ref = $2`,
      [a, b],
    );
    await expect(store.get(a)).rejects.toBeInstanceOf(SecretUnreadableError);
    expect(await store.get(b)).toBe('value-of-b');
    await t.pool.query(
      "update governance.secrets set ciphertext = 'AAAA' || substr(ciphertext, 5) where ref = $1",
      [b],
    );
    await expect(store.get(b)).rejects.toMatchObject({ reason: 'integrity' });
  });

  it('cannot be read with another master key', async () => {
    const ref = await store.put({ ...owner, value: SECRET });
    const other = new DbEnvelopeSecretStore(t.db, parseMasterKey(generateMasterKey()));
    await expect(other.get(ref)).rejects.toMatchObject({ reason: 'unknown_key' });
  });

  it('rotates a value, deletes a secret, and reports unknown references', async () => {
    const ref = await store.put({ ...owner, value: 'old-value' });
    await store.rotate(ref, 'new-value');
    expect(await store.get(ref)).toBe('new-value');
    expect((await store.describe(ref))?.rotatedAt).toBeInstanceOf(Date);
    await store.delete(ref);
    await expect(store.get(ref)).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(store.rotate(ref, 'x')).rejects.toBeInstanceOf(SecretNotFoundError);
    expect(await store.describe(ref)).toBeNull();
  });

  it('joins the caller transaction: a rollback leaves no secret', async () => {
    const before = (await t.pool.query('select count(*)::int c from governance.secrets')).rows[0].c;
    await expect(
      t.db.transaction(async (tx) => {
        await store.put({ ...owner, value: 'rolled-back' }, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await t.pool.query('select count(*)::int c from governance.secrets')).rows[0].c).toBe(before);
  });

  it('master key rotation re-wraps everything; the old key is then no longer needed', async () => {
    await t.pool.query('delete from governance.secrets');
    const refs = [await store.put({ ...owner, value: 'one' }), await store.put({ ...owner, value: 'two' })];
    const next = parseMasterKey(generateMasterKey());
    const rotating = new DbEnvelopeSecretStore(t.db, next, [master]);
    expect(await rotating.get(refs[0]!)).toBe('one'); // readable during the transition
    expect(await rotating.rewrapAll()).toBe(2);
    expect(await rotating.rewrapAll()).toBe(0);
    const onlyNew = new DbEnvelopeSecretStore(t.db, next);
    expect(await onlyNew.get(refs[1]!)).toBe('two');
    await expect(store.get(refs[0]!)).rejects.toMatchObject({ reason: 'unknown_key' });
  });
});
