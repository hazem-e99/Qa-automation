import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { signFilePath } from '@qos/kernel-infra';
import { createApiApp, type ApiApp } from '../dist/bootstrap.js';

const SECRET = 'test-only-file-url-secret-0123456789abcdef';
let t: TestDatabase;
let api: ApiApp;
let base: string;
let dir: string;

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-api-files-'));
  api = await createApiApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_PORT: '39031',
    STORAGE_DIR: dir,
    FILE_URL_SECRET: SECRET,
  });
  base = await api.listen();
  const enc = new TextEncoder();
  await api.storage.put('runs/r1/shot.png', new Uint8Array([137, 80, 78, 71]), 'image/png');
  await api.storage.put('runs/r1/report.html', enc.encode('<script>alert(1)</script>'), 'text/html');
  await api.storage.put('runs/r1/other.txt', enc.encode('other'), 'text/plain');
}, 180_000);
afterAll(async () => {
  await api?.close();
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('signed file links', () => {
  it('serves the object for a valid link with safe headers', async () => {
    const res = await fetch(base + signFilePath(SECRET, 'runs/r1/shot.png', 60));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([137, 80, 78, 71]);
  });

  it('never serves HTML inline: stored markup is a download with a locked-down policy', async () => {
    const res = await fetch(base + signFilePath(SECRET, 'runs/r1/report.html', 60));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="report.html"');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('refuses missing, tampered, expired and wrong-secret links with the same 403', async () => {
    const good = signFilePath(SECRET, 'runs/r1/shot.png', 60);
    const cases = [
      '/files/runs/r1/shot.png',
      good.replace(/sig=.{4}/, 'sig=AAAA'),
      good.replace(/exp=\d+/, 'exp=9999999999'), // extending the expiry breaks the signature
      good.replace('shot.png', 'other.txt'), // a link is bound to its object
      signFilePath(SECRET, 'runs/r1/shot.png', -10),
      signFilePath('another-secret-another-secret-another-secret', 'runs/r1/shot.png', 60),
      good + '&exp=1',
    ];
    for (const c of cases) {
      const res = await fetch(base + c);
      expect(res.status, c).toBe(403);
      expect(await res.json(), c).toMatchObject({ code: 'http.403' });
    }
  });

  it('cannot be used to read outside the storage root, even with a valid signature', async () => {
    for (const key of ['../../package.json', '..%2f..%2fpackage.json', 'runs/../../../etc/passwd']) {
      const res = await fetch(base + signFilePath(SECRET, key, 60));
      expect([403, 404], key).toContain(res.status);
      expect(await res.text(), key).not.toContain('"name"');
    }
  });

  it('answers 404 for a signed link to an object that does not exist', async () => {
    expect((await fetch(base + signFilePath(SECRET, 'runs/r1/none.png', 60))).status).toBe(404);
  });

  it('is disabled (404) when no secret is configured', async () => {
    const plain = await createApiApp({
      DATABASE_URL: t.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      API_PORT: '39032',
    });
    const url = await plain.listen();
    try {
      expect((await fetch(url + signFilePath(SECRET, 'runs/r1/shot.png', 60))).status).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it('rejects a secret that is too short at boot', async () => {
    await expect(
      createApiApp({ DATABASE_URL: t.url, NODE_ENV: 'test', FILE_URL_SECRET: 'short' }),
    ).rejects.toThrow(/FILE_URL_SECRET/);
  });
});
