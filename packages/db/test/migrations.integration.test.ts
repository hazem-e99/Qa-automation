import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, runMigrations, sql, verifyAuditChain } from '../src/index.js';
import { startTestDatabase, type TestDatabase } from '../src/testing.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
}, 180_000);
afterAll(async () => {
  await t?.stop();
});

const audit = (action: string) => ({
  actorType: 'system' as const,
  actorId: 'test',
  action,
  targetType: 'probe',
  targetId: 'p1',
  summary: { b: 2, a: 1 },
  source: 'system' as const,
});

describe('migrations', () => {
  it('apply on a clean database and are idempotent', async () => {
    await runMigrations(t.pool);
    const ext = await t.pool.query(
      "select extname from pg_extension where extname in ('vector','pg_trgm','citext') order by 1",
    );
    expect(ext.rows.map((r) => r.extname)).toEqual(['citext', 'pg_trgm', 'vector']);
    const tables = await t.pool.query(
      "select table_schema || '.' || table_name as n from information_schema.tables where table_schema in ('platform','governance') order by 1",
    );
    const names = tables.rows.map((r) => r.n);
    expect(names).toContain('platform.outbox_events');
    expect(names).toContain('platform.probes');
    expect(names).toContain('governance.audit_events');
  });

  it('creates audit partitions for the current and next month', async () => {
    const now = new Date();
    const name = (offset: number) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
      return `audit_events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    const parts = await t.pool.query(
      "select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent where p.relname = 'audit_events'",
    );
    const names = parts.rows.map((r) => r.relname);
    expect(names).toEqual(expect.arrayContaining([name(0), name(1), 'audit_events_default']));
  });
});

describe('audit log', () => {
  it('links events into a verifiable hash chain', async () => {
    await t.db.transaction(async (tx) => {
      await appendAudit(tx, audit('probe.one'));
      await appendAudit(tx, audit('probe.two'));
    });
    await t.db.transaction(async (tx) => {
      await appendAudit(tx, audit('probe.three'));
    });
    const result = await t.db.transaction((tx) => verifyAuditChain(tx));
    expect(result).toEqual({ checked: 3, brokenAt: null });
  });

  it('keeps the chain intact under concurrent writers', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        t.db.transaction((tx) => appendAudit(tx, audit(`probe.concurrent.${i}`))),
      ),
    );
    const result = await t.db.transaction((tx) => verifyAuditChain(tx));
    expect(result.brokenAt).toBeNull();
    expect(result.checked).toBe(15);
  });

  it('rejects UPDATE and DELETE (append-only)', async () => {
    await expect(t.db.execute(sql`update governance.audit_events set action = 'tampered'`)).rejects.toThrow();
    await expect(t.db.execute(sql`delete from governance.audit_events`)).rejects.toThrow();
    const result = await t.db.transaction((tx) => verifyAuditChain(tx));
    expect(result.brokenAt).toBeNull();
  });

  it('does not write the audit row when the transaction rolls back', async () => {
    const before = await t.pool.query('select count(*)::int c from governance.audit_events');
    await expect(
      t.db.transaction(async (tx) => {
        await appendAudit(tx, audit('probe.rolled-back'));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const after = await t.pool.query('select count(*)::int c from governance.audit_events');
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });
});
