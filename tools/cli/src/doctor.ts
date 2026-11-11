import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type CheckLevel = 'ok' | 'warn' | 'fail';
export interface CheckResult {
  readonly name: string;
  readonly level: CheckLevel;
  readonly detail: string;
}
export interface DoctorOptions {
  readonly repoRoot: string;
  readonly nodeVersion?: string;
  readonly exec?: (cmd: string, args: string[]) => Promise<string>;
  readonly fetchStatus?: (url: string) => Promise<number | null>;
  readonly freeBytes?: (dir: string) => Promise<number>;
}

const defaultExec = async (cmd: string, args: string[]) =>
  (await run(cmd, args, { timeout: 15_000 })).stdout.trim();
const defaultFetch = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).status;
  } catch {
    return null;
  }
};
const defaultFree = async (dir: string) => {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
};

/** Parses KEY=value lines. Values are never printed by the doctor. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export async function runDoctor(opts: DoctorOptions): Promise<CheckResult[]> {
  const exec = opts.exec ?? defaultExec;
  const fetchStatus = opts.fetchStatus ?? defaultFetch;
  const freeBytes = opts.freeBytes ?? defaultFree;
  const results: CheckResult[] = [];
  const add = (name: string, level: CheckLevel, detail: string) => results.push({ name, level, detail });

  const node = opts.nodeVersion ?? process.versions.node;
  const major = Number(node.split('.')[0]);
  add(
    'node',
    major === 24 ? 'ok' : 'fail',
    major === 24 ? `v${node}` : `v${node} found, Node 24 LTS required`,
  );

  try {
    add('docker', 'ok', `engine ${await exec('docker', ['version', '--format', '{{.Server.Version}}'])}`);
  } catch {
    add('docker', 'fail', 'Docker engine not reachable. Start Docker Desktop.');
  }
  try {
    add('docker compose', 'ok', await exec('docker', ['compose', 'version', '--short']));
  } catch {
    add('docker compose', 'fail', 'docker compose plugin not found');
  }

  const envFile = path.join(opts.repoRoot, 'infra', 'compose', '.env');
  if (!existsSync(envFile)) {
    add('env file', 'fail', 'infra/compose/.env is missing. Run: pnpm qos init');
  } else {
    const env = parseEnv(readFileSync(envFile, 'utf8'));
    const weak = ['POSTGRES_PASSWORD', 'FILE_URL_SECRET', 'SETUP_TOKEN'].filter(
      (k) => !env[k] || env[k]!.length < 32 || /change-me|<generated/i.test(env[k]!),
    );
    add(
      'env file',
      weak.length ? 'fail' : 'ok',
      weak.length ? `weak or placeholder values: ${weak.join(', ')}` : 'present, secrets look generated',
    );
  }

  add(
    'master key',
    existsSync(path.join(opts.repoRoot, 'secrets', 'master.key')) ? 'ok' : 'fail',
    existsSync(path.join(opts.repoRoot, 'secrets', 'master.key'))
      ? 'present'
      : 'secrets/master.key is missing. Run: pnpm qos init',
  );

  try {
    const gb = (await freeBytes(opts.repoRoot)) / 1024 ** 3;
    add(
      'disk space',
      gb >= 10 ? 'ok' : gb >= 3 ? 'warn' : 'fail',
      `${gb.toFixed(1)} GB free on the repository drive`,
    );
  } catch {
    add('disk space', 'warn', 'could not be determined');
  }

  for (const [name, url] of [
    ['api', 'http://127.0.0.1:3001/readyz'],
    ['web', 'http://127.0.0.1:3000/en'],
  ] as const) {
    const status = await fetchStatus(url);
    add(
      `${name} reachable`,
      status === 200 ? 'ok' : 'warn',
      status === 200
        ? 'ready'
        : status === null
          ? 'not running (start with: pnpm stack:up)'
          : `answered ${status}`,
    );
  }
  return results;
}

export const exitCodeFor = (results: readonly CheckResult[]): number =>
  results.some((r) => r.level === 'fail') ? 1 : 0;
