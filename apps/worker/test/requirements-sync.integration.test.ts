import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCK_WORK_ITEMS, MockRequirementsSource } from '@qos/adapters-mock';
import { DbEnvelopeSecretStore, generateMasterKey, parseMasterKey } from '@qos/adapters-secrets-db';
import { LocalFsObjectStorage } from '@qos/adapters-storage-localfs';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { createConnection, ProviderRegistry, testConnection } from '@qos/integrations';
import { uuidv7 } from '@qos/kernel-domain';
import { createLogger } from '@qos/observability';
import { receiveInboxMessage } from '@qos/platform';
import {
  acceptCandidates,
  createManualRequirement,
  getRequirement,
  listCandidates,
  listRequirements,
  onRequirementItemChanged,
  requirementTrace,
  uploadDocument,
} from '@qos/requirements';
import { createLink } from '@qos/traceability';
// Boot tests run against the compiled output, exactly what `node dist/main.js` runs.
import { createWorkerApp, type WorkerApp } from '../dist/bootstrap.js';

/**
 * External requirements end to end in the worker (T-P3-10): a requirements binding to the demo
 * tracker is synced, every work item becomes a draft requirement; documents and a spreadsheet are
 * uploaded and accepted next to them (M04-AC-01); a change at the tracker creates a new draft
 * version while the approved one stays effective and linked tests are flagged (M04-AC-03); a
 * removal marks the requirement. The webhook path re-fetches through the API.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CORPUS = path.join(ROOT, 'spikes/parser/corpus/files');
const PARSED = path.join(ROOT, 'packages/modules/requirements/test/fixtures/parsed');

let t: TestDatabase;
let dir: string;
let worker: WorkerApp;
let sidecar: Server;
let connectionId: string;
let bindingId: string;
const actor = {
  kind: 'user',
  orgId: uuidv7(),
  userId: uuidv7(),
  email: 'sync@example.test',
  displayName: 'Sync',
  orgRoles: [],
  sessionId: 'x',
} as const;
type Project = Parameters<typeof uploadDocument>[2];
let project: Project;

const until = async (cond: () => Promise<boolean>, ms = 40_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('condition not met in time');
};
const one = async <T>(sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0] as T;
const reqIdOf = async (workItem: string) =>
  (
    await one<{ id: string }>(
      `select r.id from requirements.requirements r
       join requirements.requirement_versions v on v.requirement_id = r.id and v.number = 1
       where r.project_id = $1 and v.title like $2`,
      [project.id, `${workItem}: %`],
    )
  ).id;
const webhook = (key: string) =>
  receiveInboxMessage(t.db, {
    connectionId,
    dedupeKey: key,
    eventType: 'workitem.updated',
    verification: 'ok',
    headers: {},
  });

beforeAll(async () => {
  MOCK_WORK_ITEMS.reset();
  t = await startTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'qos-worker-reqsync-'));
  const key = generateMasterKey();
  await writeFile(path.join(dir, 'master.key'), key);
  sidecar = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const name = /filename="([^"]+)"/.exec(Buffer.concat(chunks).toString('latin1'))?.[1] ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(readFileSync(path.join(PARSED, name.replace(/\.[a-z]+$/, '.json'))));
    });
  });
  await new Promise<void>((r) => sidecar.listen(0, '127.0.0.1', r));

  const deps = {
    db: t.db,
    registry: new ProviderRegistry().register(new MockRequirementsSource()),
    secrets: new DbEnvelopeSecretStore(t.db, parseMasterKey(key)),
    http: { request: async () => Promise.reject(new Error('no network')) },
    logger: createLogger({ service: 'test', level: 'silent' }),
  };
  connectionId = (
    await createConnection(deps, actor, {
      providerType: 'mock_requirements',
      displayName: 'Demo tracker',
      authStrategy: 'pat',
      credential: 'mock-token',
    })
  ).id;
  await testConnection(deps, actor, connectionId);
  const projectId = uuidv7();
  await t.pool.query(
    `insert into projects.projects (id, org_id, key, name, status, is_demo, created_by, created_at, updated_at)
     values ($1, $2, 'EXT', 'External', 'active', true, $3, now(), now())`,
    [projectId, actor.orgId, actor.userId],
  );
  project = {
    id: projectId,
    orgId: actor.orgId,
    key: 'EXT',
    name: 'External',
    description: '',
    tags: [],
    status: 'active',
    isDemo: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  bindingId = uuidv7();
  await t.pool.query(
    `insert into projects.project_bindings (id, project_id, role, connection_id, config, mode, started_at, started_by)
     values ($1, $2, 'requirements', $3, '{"project":"Shop"}', 'active', now(), $4)`,
    [bindingId, projectId, connectionId, actor.userId],
  );
  worker = await createWorkerApp({
    DATABASE_URL: t.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WORKER_HEALTH_PORT: '0',
    JOB_POLL_SECONDS: '0.5',
    SYNC_POLL_SECONDS: '3600',
    INBOX_POLL_SECONDS: '1',
    QOS_MASTER_KEY_FILE: path.join(dir, 'master.key'),
    QOS_DEMO_MODE: 'true',
    STORAGE_DIR: dir,
    PARSER_URL: `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`,
  });
}, 180_000);
afterAll(async () => {
  await worker?.close();
  await new Promise<void>((r) => (sidecar ? sidecar.close(() => r()) : r()));
  await t?.stop();
  await rm(dir, { recursive: true, force: true });
  MOCK_WORK_ITEMS.reset();
});

describe('external requirements in the worker (T-P3-10)', () => {
  it('the first sync turns every tracker item into a draft requirement with its criteria and a tracker link', async () => {
    await until(async () => (await listRequirements(t.db, project, { limit: 500 })).length === 45);
    const r = await getRequirement(t.db, project, await reqIdOf('503'));
    expect(r).toMatchObject({ state: 'draft', latestVersion: 1, sourceKinds: ['external'] });
    expect(r.versions[0]!.acceptanceCriteria.map((a) => a.text)).toEqual([
      'Given a signed-in shopper',
      'When they use checkout step 3',
      'Then the step completes within 2 seconds',
    ]);
    expect(r.provenance[0]!.locator).toMatchObject({
      workItem: '503',
      revision: '1',
      url: 'https://mock.example.test/demo-org/_workitems/edit/503',
    });
    const source = await one<{ kind: string; binding_id: string }>(
      `select kind, binding_id from requirements.requirement_sources where project_id = $1`,
      [project.id],
    );
    expect(source).toEqual({ kind: 'external', binding_id: bindingId });
  });

  it('documents, a spreadsheet and manual entries join the same list (M04-AC-01)', async () => {
    const storage = new LocalFsObjectStorage(dir);
    const deps = { db: t.db, storage, jobs: worker.infra.jobs };
    const sources: Record<string, string> = {};
    for (const [kind, name] of [
      ['document_set', 'Specs'],
      ['spreadsheet', 'Backlog sheet'],
    ] as const) {
      sources[kind] = uuidv7();
      await t.pool.query(
        `insert into requirements.requirement_sources (id, project_id, kind, name, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, now(), now())`,
        [sources[kind], project.id, kind, name, actor.userId],
      );
    }
    const uploads = [];
    for (const [kind, file] of [
      ['document_set', 'd02-auth-en-table.docx'],
      ['spreadsheet', 'x22-auth-en-sheet.xlsx'],
    ] as const) {
      uploads.push(
        await uploadDocument(deps, actor, project, sources[kind]!, {
          fileName: file,
          bytes: new Uint8Array(readFileSync(path.join(CORPUS, file))),
        }),
      );
    }
    for (const u of uploads) {
      await until(
        async () =>
          (
            await one<{ s: string }>(
              'select parse_status s from requirements.source_snapshots where id = $1',
              [u.snapshotId],
            )
          ).s === 'parsed',
      );
      const open = await listCandidates(t.db, project, u.snapshotId, { status: 'candidate' });
      await acceptCandidates(t.db, actor, project, [open[0]!.id]);
    }
    await createManualRequirement(t.db, actor, project, {
      title: 'Shoppers can change the interface language',
      bodyMd: '',
      priority: null,
      tags: [],
      acceptanceCriteria: [],
    });
    const list = await listRequirements(t.db, project, { limit: 500 });
    expect(list).toHaveLength(48);
    expect(new Set(list.flatMap((r) => r.sourceKinds))).toEqual(
      new Set(['external', 'document_set', 'spreadsheet', 'manual']),
    );
  });

  it('a change at the tracker makes a new draft version; the approved one stays effective and linked tests are flagged (M04-AC-03)', async () => {
    const id = await reqIdOf('503');
    // Approve version 1 (the approval workflow itself is covered by the API tests).
    await t.pool.query(
      `update requirements.requirement_versions set state = 'approved', approved_at = now() where requirement_id = $1 and number = 1`,
      [id],
    );
    await t.pool.query(
      `update requirements.requirements r set effective_version_id = v.id
       from requirements.requirement_versions v where v.requirement_id = r.id and v.number = 1 and r.id = $1`,
      [id],
    );
    const testCase = uuidv7();
    await createLink(t.db, project, {
      type: 'verifies',
      from: { type: 'test_case', id: testCase },
      to: { type: 'requirement', id },
      origin: 'system',
      createdBy: null,
    });
    MOCK_WORK_ITEMS.update('503', {
      title: 'As a shopper I want instant search so that I find products faster',
      ac: 'Given a signed-in shopper\nWhen they type two letters\nThen suggestions appear within 300 ms',
    });
    await webhook('delivery:req-1');
    await until(async () => (await getRequirement(t.db, project, id)).latestVersion === 2);
    const r = await getRequirement(t.db, project, id);
    expect(r).toMatchObject({ state: 'draft', effectiveVersion: 1, latestVersion: 2 });
    expect(r.versions.find((v) => v.number === 1)!.state).toBe('approved');
    expect(r.versions.find((v) => v.number === 2)!.title).toBe(
      '503: As a shopper I want instant search so that I find products faster',
    );
    expect(r.provenance.map((p) => p.locator.revision)).toEqual(['2', '2', '2', '2']);
    const trace = await requirementTrace(t.db, project, id);
    expect(trace.verifiedBy).toEqual([
      expect.objectContaining({
        testCaseId: testCase,
        needsReview: true,
        reviewReason: expect.objectContaining({ kind: 'source_changed' }),
      }),
    ]);
    // Only the changed item made a new version.
    expect((await getRequirement(t.db, project, await reqIdOf('504'))).latestVersion).toBe(1);
  });

  it('handling the same event twice changes nothing (at-least-once delivery)', async () => {
    const event = await one<{
      id: string;
      type: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(
      `select id, type, aggregate_type, aggregate_id, payload from platform.outbox_events
       where type = 'integration.requirement_item.changed' and payload->>'externalId' = '503'
       order by occurred_at desc limit 1`,
    );
    const outcome = await t.db.transaction((tx) =>
      onRequirementItemChanged(
        {
          eventId: event.id,
          type: event.type,
          aggregateType: event.aggregate_type,
          aggregateId: event.aggregate_id,
          projectId: project.id,
          occurredAt: new Date(),
          correlationId: null,
          payload: event.payload,
        },
        tx,
      ),
    );
    expect(outcome).toBe('duplicate');
    expect((await getRequirement(t.db, project, await reqIdOf('503'))).latestVersion).toBe(2);
  });

  it('an item removed at the tracker marks its requirement and changes nothing else (BR-M04-5)', async () => {
    const id = await reqIdOf('510');
    MOCK_WORK_ITEMS.update('510', { state: 'Removed' });
    await webhook('delivery:req-2');
    await until(async () => (await getRequirement(t.db, project, id)).sourceRemoved);
    const r = await getRequirement(t.db, project, id);
    expect(r).toMatchObject({ sourceRemoved: true, latestVersion: 1, state: 'draft' });
  });
});
