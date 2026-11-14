import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFsObjectStorage } from '@qos/adapters-storage-localfs';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { uuidv7 } from '@qos/kernel-domain';
import { uploadDocument } from '@qos/requirements';
// Boot tests run against the compiled output, exactly what `node dist/main.js` runs.
import { createWorkerApp, type WorkerApp } from '../dist/bootstrap.js';

/**
 * The parse path as deployed (T-P3-05): an upload queues `requirements.parse`, the worker takes
 * the job, calls the parser sidecar over HTTP and stores the candidates. The sidecar is a stand-in
 * that answers with the real parser's output for the corpus file it receives.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CORPUS = path.join(ROOT, 'spikes/parser/corpus/files');
const PARSED = path.join(ROOT, 'packages/modules/requirements/test/fixtures/parsed');

let t: TestDatabase;
let dir: string;
let worker: WorkerApp;
let sidecar: Server;
let mode: 'ok' | 'reject' = 'ok';
const received: string[] = [];
const actor = {
  kind: 'user',
  orgId: uuidv7(),
  userId: uuidv7(),
  email: 'w@example.test',
  displayName: 'W',
  orgRoles: [],
  sessionId: 'x',
} as const;
type Project = Parameters<typeof uploadDocument>[2];
let project: Project;
let sourceId: string;

const until = async (cond: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('condition not met in time');
};
const statusOf = async (id: string) =>
  (await t.pool.query('select parse_status from requirements.source_snapshots where id = $1', [id])).rows[0]
    ?.parse_status as string;

beforeAll(async () => {
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-worker-parse-'));
  sidecar = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      const name = /filename="([^"]+)"/.exec(body)?.[1] ?? '';
      received.push(name);
      res.writeHead(mode === 'ok' ? 200 : 422, { 'content-type': 'application/json' });
      res.end(
        mode === 'ok'
          ? readFileSync(path.join(PARSED, name.replace(/\.[a-z]+$/, '.json')))
          : JSON.stringify({ detail: { code: 'pdf_unreadable' } }),
      );
    });
  });
  await new Promise<void>((r) => sidecar.listen(0, '127.0.0.1', r));
  const projectId = uuidv7();
  await t.pool.query(
    `insert into projects.projects (id, org_id, key, name, status, is_demo, created_by, created_at, updated_at)
     values ($1, $2, 'PRS', 'Parse', 'active', false, $3, now(), now())`,
    [projectId, actor.orgId, actor.userId],
  );
  project = {
    id: projectId,
    orgId: actor.orgId,
    key: 'PRS',
    name: 'Parse',
    description: '',
    tags: [],
    status: 'active',
    isDemo: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  sourceId = uuidv7();
  await t.pool.query(
    `insert into requirements.requirement_sources (id, project_id, kind, name, created_by, created_at, updated_at)
     values ($1, $2, 'document_set', 'Specs', $3, now(), now())`,
    [sourceId, projectId, actor.userId],
  );
  worker = await createWorkerApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WORKER_HEALTH_PORT: '0',
    JOB_POLL_SECONDS: '0.5',
    SYNC_POLL_SECONDS: '3600',
    STORAGE_DIR: dir,
    PARSER_URL: `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`,
  });
}, 180_000);
afterAll(async () => {
  await worker?.close();
  await new Promise<void>((r) => (sidecar ? sidecar.close(() => r()) : r()));
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
});

const deps = () => ({ db: t.db, storage: new LocalFsObjectStorage(dir), jobs: worker.infra.jobs });

describe('parse job in the worker', () => {
  it('an upload is parsed by the sidecar and its candidates stored', async () => {
    const file = 'd03-booking-en-stories.docx';
    const up = await uploadDocument(deps(), actor, project, sourceId, {
      fileName: file,
      bytes: new Uint8Array(readFileSync(path.join(CORPUS, file))),
    });
    await until(async () => (await statusOf(up.snapshotId)) === 'parsed');
    expect(received).toEqual([file]);
    const items = await t.pool.query(
      `select kind, count(*)::int n from requirements.extracted_items where snapshot_id = $1 group by kind order by kind`,
      [up.snapshotId],
    );
    expect(items.rows.find((r) => r.kind === 'requirement')?.n).toBeGreaterThan(0);
    const stored = await new LocalFsObjectStorage(dir).exists(
      `projects/${project.id}/requirement-sources/${sourceId}/snapshots/${up.snapshotId}/parsed.json`,
    );
    expect(stored).toBe(true);
  });

  it('a document the parser cannot read fails without retries', async () => {
    mode = 'reject';
    const file = 'p09-library-en-numbered.pdf';
    const up = await uploadDocument(deps(), actor, project, sourceId, {
      fileName: file,
      bytes: new Uint8Array(readFileSync(path.join(CORPUS, file))),
    });
    await until(async () => (await statusOf(up.snapshotId)) === 'failed');
    expect(received.filter((n) => n === file)).toHaveLength(1);
  });
});
