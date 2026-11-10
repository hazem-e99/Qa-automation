import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@qos/db';
import { startTestDatabase, type TestDatabase } from '@qos/db/testing';
import { uuidv7 } from '@qos/kernel-domain';
import { createLogger } from '@qos/observability';
import {
  createOperation,
  getOperation,
  InboxProcessor,
  purgeExpiredIdempotencyKeys,
  receiveInboxMessage,
  transitionOperation,
  withIdempotency,
} from '../src/index.js';

const logger = createLogger({ service: 'test', level: 'silent' });
let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
  await t.pool.query('create table public.effects (id serial primary key, note text not null)');
}, 180_000);
afterAll(async () => {
  await t?.stop();
});

const effects = async () =>
  (await t.pool.query('select count(*)::int c from public.effects')).rows[0].c as number;
const key = () => `key-${uuidv7()}`;

describe('idempotency', () => {
  const run = (k: string, request: unknown, fail = false) =>
    withIdempotency(t.db, { scope: 'test', key: k, request }, async (tx) => {
      await tx.execute(sql`insert into public.effects (note) values ('x')`);
      if (fail) throw new Error('effect failed');
      return { status: 201, body: { made: true } };
    });

  it('runs the effect once and replays the stored response for a repeated key', async () => {
    const k = key();
    const before = await effects();
    const first = await run(k, { a: 1, b: 2 });
    const second = await run(k, { b: 2, a: 1 }); // same content, different key order
    expect(first).toEqual({ status: 201, body: { made: true }, replayed: false });
    expect(second).toEqual({ status: 201, body: { made: true }, replayed: true });
    expect(await effects()).toBe(before + 1);
  });

  it('rejects the same key with a different request', async () => {
    const k = key();
    await run(k, { a: 1 });
    await expect(run(k, { a: 2 })).rejects.toThrow('idempotency.key_reused');
  });

  it('stores nothing when the effect fails, so the key can be retried', async () => {
    const k = key();
    const before = await effects();
    await expect(run(k, { a: 1 }, true)).rejects.toThrow('effect failed');
    expect(await effects()).toBe(before);
    expect((await run(k, { a: 1 })).replayed).toBe(false);
    expect(await effects()).toBe(before + 1);
  });

  it('runs the effect once under concurrent requests with the same key', async () => {
    const k = key();
    const before = await effects();
    const results = await Promise.all(Array.from({ length: 8 }, () => run(k, { same: true })));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await effects()).toBe(before + 1);
  });

  it('rejects malformed keys and lets an expired key be used again', async () => {
    await expect(run('short', {})).rejects.toThrow('idempotency.key_invalid');
    await expect(run('has spaces and "quotes"', {})).rejects.toThrow('idempotency.key_invalid');
    const k = key();
    await run(k, { a: 1 });
    await t.pool.query(
      "update platform.idempotency_keys set expires_at = now() - interval '1 second' where key = $1",
      [k],
    );
    expect((await run(k, { a: 99 })).replayed).toBe(false);
    await t.pool.query("update platform.idempotency_keys set expires_at = now() - interval '1 second'");
    expect(await purgeExpiredIdempotencyKeys(t.db)).toBeGreaterThan(0);
  });
});

describe('operations', () => {
  it('moves forward only from an expected status', async () => {
    const id = await createOperation(t.db, { type: 'test.op', createdBy: 'tester' });
    expect(await getOperation(t.db, id)).toMatchObject({ status: 'queued', progress: 0 });
    expect(await transitionOperation(t.db, id, ['queued'], { status: 'running', progress: 40 })).toBe(true);
    expect(await transitionOperation(t.db, id, ['queued'], { status: 'running' })).toBe(false); // redelivery
    expect(await transitionOperation(t.db, id, ['running'], { status: 'succeeded', progress: 250 })).toBe(
      true,
    );
    expect(await getOperation(t.db, id)).toMatchObject({ status: 'succeeded', progress: 100 });
    expect(await transitionOperation(t.db, id, ['running'], { status: 'failed', error: 'late' })).toBe(false);
    expect(await getOperation(t.db, uuidv7())).toBeNull();
  });

  it('notifies listeners when an operation changes', async () => {
    const client = await t.pool.connect();
    try {
      const seen: string[] = [];
      client.on('notification', (n) => seen.push(n.payload ?? ''));
      await client.query('listen qos_operations');
      const id = await createOperation(t.db, { type: 'test.op', createdBy: 'tester' });
      await transitionOperation(t.db, id, ['queued'], { status: 'running' });
      await new Promise((r) => setTimeout(r, 300));
      expect(seen.filter((p) => p === id)).toHaveLength(2);
    } finally {
      client.release();
    }
  });
});

describe('inbox', () => {
  const msg = (connectionId: string, dedupeKey: string, eventType = 'thing.changed') => ({
    connectionId,
    dedupeKey,
    eventType,
    verification: 'ok' as const,
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token', cookie: 'sid=1' },
  });

  it('stores a delivery once; a redelivery is a duplicate; secrets in headers are dropped', async () => {
    const conn = uuidv7();
    const first = await receiveInboxMessage(t.db, msg(conn, 'delivery-1'));
    const again = await receiveInboxMessage(t.db, msg(conn, 'delivery-1'));
    const other = await receiveInboxMessage(t.db, msg(uuidv7(), 'delivery-1')); // same key, other connection
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ id: null, duplicate: true });
    expect(other.duplicate).toBe(false);
    const row = await t.pool.query('select headers from platform.inbox_messages where id = $1', [first.id]);
    expect(row.rows[0].headers).toEqual({ 'content-type': 'application/json' });
    await expect(
      t.pool.query(
        "insert into platform.inbox_messages (id, connection_id, dedupe_key, event_type, received_at, verification, headers, status) values ($1, $2, 'delivery-1', 'x', now(), 'ok', '{}', 'pending')",
        [uuidv7(), conn],
      ),
    ).rejects.toThrow(/inbox_connection_dedupe_ux/);
  });

  it('processes pending messages, ignores unknown types, and parks a poison message', async () => {
    await t.pool.query("update platform.inbox_messages set status = 'processed'");
    const conn = uuidv7();
    const good = await receiveInboxMessage(t.db, msg(conn, 'g1', 'good'));
    const unknown = await receiveInboxMessage(t.db, msg(conn, 'u1', 'unknown.type'));
    const poison = await receiveInboxMessage(t.db, msg(conn, 'p1', 'poison'));
    const processor = new InboxProcessor({ db: t.db, logger, maxAttempts: 3 });
    const handled: string[] = [];
    processor.register('good', async (m) => {
      handled.push(m.id);
      return 'processed';
    });
    processor.register('poison', async () => {
      throw new Error('cannot handle');
    });
    const status = async (id: string | null) =>
      (await t.pool.query('select status, attempts from platform.inbox_messages where id = $1', [id]))
        .rows[0];

    expect(await processor.drain()).toBe(2);
    expect(await status(good.id)).toMatchObject({ status: 'processed' });
    expect(await status(unknown.id)).toMatchObject({ status: 'ignored_out_of_scope' });
    expect(await status(poison.id)).toEqual({ status: 'pending', attempts: 1 });
    await processor.drain();
    expect(await processor.drain()).toBe(1);
    expect(await status(poison.id)).toEqual({ status: 'failed', attempts: 3 });
    expect(await processor.drain()).toBe(0);
    expect(handled).toEqual([good.id]);
  });
});
