// Backend for the journey tests: a throwaway PostgreSQL (Testcontainers) and the API from its
// compiled output, in demo mode. Started by Playwright as a web server; stops on SIGTERM/SIGINT.
import { Buffer } from 'node:buffer';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { generateMasterKey } from '@qos/adapters-secrets-db';
import { createApiApp } from '@qos/api/bootstrap';
import { startTestDatabase } from '@qos/db/testing';
import { processParseJob } from '@qos/requirements';

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
    STORAGE_DIR: path.join(dir, 'storage'),
  },
  { logDestination: { write: (line) => appendFileSync(LOG_FILE, line) } },
);
// Uploaded documents are read by a stand-in for the parser sidecar that answers with the real
// parser's output for the P0 corpus file of the same name (services/parser/tools/dump_corpus.py).
const PARSED = path.resolve('../../packages/modules/requirements/test/fixtures/parsed');
const parser = {
  async parse(input) {
    const name = input.fileName.replace(/.[a-z]+$/i, '');
    const doc = JSON.parse(readFileSync(path.join(PARSED, `${name}.json`), 'utf8'));
    if (input.kind !== 'docx') return doc;
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const layoutHtml = doc.blocks
      .map((b) => (b.type === 'heading' ? `<h2>${esc(b.text)}</h2>` : `<p>${esc(b.text)}</p>`))
      .join('');
    return { ...doc, layoutHtml };
  },
  // Pages as images: a small white PNG stands in for the PDFium rendering of the sidecar.
  async renderPage() {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64',
    );
    return { png: new Uint8Array(png), pageCount: 1 };
  },
};
await api.infra.jobs.work('requirements.parse', async (job) => {
  await processParseJob({ db: api.infra.db, storage: api.storage, jobs: api.infra.jobs, parser }, job.data);
});
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
