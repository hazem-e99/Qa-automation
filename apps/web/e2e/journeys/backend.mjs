// Backend for the journey tests: a throwaway PostgreSQL (Testcontainers) and the API from its
// compiled output, in demo mode. Started by Playwright as a web server; stops on SIGTERM/SIGINT.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import { createApiApp } from '@qos/api/bootstrap';
import { startTestDatabase } from '@qos/db/testing';

export const SETUP_TOKEN = 'journey-test-setup-token-0123456789abcdef';
const API_PORT = process.env.JOURNEY_API_PORT ?? '3101';
const WEB_URL = process.env.JOURNEY_WEB_URL ?? 'http://127.0.0.1:3102';

// Every API log line goes to this file; the last journey scans it for secrets (M14-AC-07).
const LOG_FILE = process.env.JOURNEY_LOG_FILE ?? path.resolve('test-results/journeys/api.log');
mkdirSync(path.dirname(LOG_FILE), { recursive: true });
writeFileSync(LOG_FILE, '');

const db = await startTestDatabase();
const dir = await mkdtemp(path.join(tmpdir(), 'qos-journeys-'));
const keyFile = path.join(dir, 'master.key');
await writeFile(keyFile, generateMasterKey());
const api = await createApiApp(
  {
    DATABASE_URL: db.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'debug',
    API_PORT,
    WEBHOOK_PORT: '0',
    QOS_MASTER_KEY_FILE: keyFile,
    QOS_DEMO_MODE: 'true',
    SETUP_TOKEN,
    COOKIE_SECURE: 'false',
    PUBLIC_WEB_URL: WEB_URL,
    TRUST_PROXY: 'loopback',
    RATE_LIMIT_RPS: '500',
    RATE_LIMIT_BURST: '2000',
    LOGIN_ATTEMPTS_PER_MINUTE: '100',
  },
  { logDestination: { write: (line) => appendFileSync(LOG_FILE, line) } },
);
const url = await api.listen();
process.stdout.write(`journey backend ready at ${url}\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await api.close().catch(() => undefined);
  await db.stop().catch(() => undefined);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
