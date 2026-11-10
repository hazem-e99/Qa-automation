import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitCodeFor, parseEnv, runDoctor } from './doctor.js';
import { initEnv, renderEnv } from './init.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qos-cli-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('qos init', () => {
  it('writes generated secrets and never overwrites an existing file', async () => {
    const first = await initEnv(root);
    expect(first.created).toBe(true);
    const content = await readFile(first.path, 'utf8');
    const env = parseEnv(content);
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(env.FILE_URL_SECRET).toMatch(/^[0-9a-f]{64}$/);
    const second = await initEnv(root);
    expect(second.created).toBe(false);
    expect(await readFile(first.path, 'utf8')).toBe(content);
  });

  it('generates different secrets every time', () => {
    expect(parseEnv(renderEnv()).POSTGRES_PASSWORD).not.toBe(parseEnv(renderEnv()).POSTGRES_PASSWORD);
  });
});

describe('qos doctor', () => {
  const healthy = {
    nodeVersion: '24.18.0',
    exec: async (_cmd: string, args: string[]) => (args[0] === 'compose' ? '2.40.0' : '29.9.3'),
    fetchStatus: async () => 200,
    freeBytes: async () => 50 * 1024 ** 3,
  };

  it('passes on a healthy machine', async () => {
    await initEnv(root);
    const results = await runDoctor({ repoRoot: root, ...healthy });
    expect(results.every((r) => r.level === 'ok')).toBe(true);
    expect(exitCodeFor(results)).toBe(0);
  });

  it('fails for a wrong Node version, missing Docker and a missing env file', async () => {
    const results = await runDoctor({
      repoRoot: root,
      ...healthy,
      nodeVersion: '20.11.0',
      exec: async () => {
        throw new Error('not found');
      },
    });
    const level = (name: string) => results.find((r) => r.name === name)?.level;
    expect(level('node')).toBe('fail');
    expect(level('docker')).toBe('fail');
    expect(level('env file')).toBe('fail');
    expect(exitCodeFor(results)).toBe(1);
  });

  it('rejects placeholder secrets without printing them, and only warns when the stack is down', async () => {
    await initEnv(root);
    const file = path.join(root, 'infra', 'compose', '.env');
    await writeFile(file, 'POSTGRES_PASSWORD=change-me-local-only\nFILE_URL_SECRET=short\n');
    const results = await runDoctor({ repoRoot: root, ...healthy, fetchStatus: async () => null });
    const env = results.find((r) => r.name === 'env file')!;
    expect(env.level).toBe('fail');
    expect(env.detail).toContain('POSTGRES_PASSWORD');
    expect(JSON.stringify(results)).not.toContain('change-me-local-only');
    expect(results.find((r) => r.name === 'api reachable')?.level).toBe('warn');
  });

  it('warns on low disk space and fails when almost none is left', async () => {
    await initEnv(root);
    const at = async (gb: number) =>
      (await runDoctor({ repoRoot: root, ...healthy, freeBytes: async () => gb * 1024 ** 3 })).find(
        (r) => r.name === 'disk space',
      )?.level;
    expect(await at(5)).toBe('warn');
    expect(await at(1)).toBe('fail');
  });
});
