import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { createProbe, getProbe } from '@qos/probe';
import { createWorkerApp, type WorkerApp } from '../dist/bootstrap.js';

/**
 * Database roles and privileges (T-P2-50, doc 10 §2, M14-AC-01). The migrate step runs with the
 * owner's connection and provisions a login role in `qos_app`; the worker then runs with it.
 */
const APP_USER = 'qos_app_test';
const APP_PASSWORD = 'test-only-app-db-password-0123';
const MIGRATE = fileURLToPath(new URL('../dist/migrate.js', import.meta.url));

let t: TestDatabase;
let appUrl: string;
let worker: WorkerApp;
let app: pg.Client;

const until = async (cond: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
};
/** Runs a statement as the services' role and returns the SQLSTATE it failed with. */
const failure = async (client: pg.Client, sql: string): Promise<string | undefined> => {
  try {
    await client.query(sql);
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

beforeAll(async () => {
  t = await startTestDatabase();
  const run = () =>
    promisify(execFile)(process.execPath, [MIGRATE], {
      env: {
        ...process.env,
        DATABASE_URL: t.url,
        QOS_APP_DB_USER: APP_USER,
        QOS_APP_DB_PASSWORD: APP_PASSWORD,
      },
    });
  await run();
  await run(); // the migrate step is idempotent
  const url = new URL(t.url);
  url.username = APP_USER;
  url.password = APP_PASSWORD;
  appUrl = url.toString();
  worker = await createWorkerApp({
    DATABASE_URL: appUrl,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WORKER_HEALTH_PORT: '0',
    JOB_POLL_SECONDS: '0.5',
  });
  app = new pg.Client({ connectionString: appUrl });
  await app.connect();
}, 180_000);
afterAll(async () => {
  await app?.end();
  await worker?.close();
  await t?.stop();
});

describe('database privileges (T-P2-50)', () => {
  it('the worker runs end to end with the services role: data, jobs, outbox and audit', async () => {
    const { id } = await createProbe(
      { db: worker.infra.db, jobs: worker.infra.jobs },
      { label: 'roles' },
      'tester',
    );
    await until(async () => {
      const p = await getProbe(t.db, id);
      return p?.processedAt != null && p.eventSeenAt != null;
    });
    const audit = await app.query(`select count(*)::int as n from governance.audit_events`);
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('the audit log is append-only by privilege, on the parent and on partitions (M14-AC-01)', async () => {
    expect(await failure(app, `update governance.audit_events set action = 'tampered'`)).toBe('42501');
    expect(await failure(app, `delete from governance.audit_events`)).toBe('42501');
    expect(await failure(app, `truncate governance.audit_events`)).toBe('42501');
    const parts = await t.pool.query(
      `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
       where i.inhparent = 'governance.audit_events'::regclass`,
    );
    expect(parts.rows.length).toBeGreaterThanOrEqual(3); // default + current and next month
    for (const { relname } of parts.rows as { relname: string }[]) {
      expect(await failure(app, `delete from governance.${relname}`), relname).toBe('42501');
      expect(await failure(app, `update governance.${relname} set action = 'x'`), relname).toBe('42501');
    }
    // A partition created later (by the owner's function) gets the same restriction.
    await app.query(`select governance.ensure_audit_partition('2031-03-01')`);
    expect(await failure(app, `delete from governance.audit_events_2031_03`)).toBe('42501');
  });

  it('the services role has no DDL anywhere', async () => {
    expect(await failure(app, `create table governance.evil (id int)`)).toBe('42501');
    expect(await failure(app, `create table public.evil (id int)`)).toBe('42501');
    expect(await failure(app, `create schema evil`)).toBe('42501');
    expect(await failure(app, `alter table identity.users add column evil int`)).toBe('42501');
    expect(await failure(app, `drop table projects.projects`)).toBe('42501');
    expect(await failure(app, `drop table pgboss.job`)).toBe('42501');
  });

  it('read-only and retention roles cannot read the secret store', async () => {
    const owner = await t.pool.connect();
    try {
      for (const role of ['qos_readonly', 'qos_retention']) {
        await owner.query(`set role ${role}`);
        await expect(owner.query('select count(*) from governance.secrets'), role).rejects.toMatchObject({
          code: '42501',
        });
        await owner.query('select count(*) from identity.users'); // everything else is readable
        await expect(owner.query(`delete from identity.sessions`), role).rejects.toMatchObject({
          code: '42501',
        });
        await owner.query('reset role');
      }
    } finally {
      owner.release();
    }
  });

  it('the login role is not privileged', async () => {
    const r = await t.pool.query(
      `select rolsuper, rolcreatedb, rolcreaterole, rolcanlogin from pg_roles where rolname = $1`,
      [APP_USER],
    );
    expect(r.rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: true,
    });
  });
});
