// T-P0-02: prove pg-boss 12 + Drizzle transactional send, and observe delivery semantics.
// Run: npm i && npm run db:up && npm run spike   (requires Docker)
import { PgBoss, fromDrizzle } from 'pg-boss';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

const url = process.env.SPIKE_DB ?? 'postgres://spike:spike@127.0.0.1:55432/spike';
const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const countJobs = async (name) => (await pool.query('select count(*)::int c from pgboss.job where name = $1', [name])).rows[0].c;

await pool.query('drop table if exists orders; create table orders (id serial primary key, item text not null)');
const boss = new PgBoss({ connectionString: url });
boss.on('error', e => console.error('boss error', e.message));
await boss.start();

// 1. Commit: domain row + job become visible together.
await boss.createQueue('spike.tx');
await db.transaction(async (tx) => {
  await tx.execute(sql`insert into orders (item) values ('commit')`);
  await boss.send('spike.tx', { item: 'commit' }, { db: fromDrizzle(tx, sql) });
});
check('commit: row + job both visible', (await pool.query("select count(*)::int c from orders where item='commit'")).rows[0].c === 1 && await countJobs('spike.tx') === 1);

// 2. Rollback: neither row nor job.
try {
  await db.transaction(async (tx) => {
    await tx.execute(sql`insert into orders (item) values ('rollback')`);
    await boss.send('spike.tx', { item: 'rollback' }, { db: fromDrizzle(tx, sql) });
    throw new Error('force rollback');
  });
} catch { /* expected */ }
check('rollback: no row, no extra job', (await pool.query("select count(*)::int c from orders where item='rollback'")).rows[0].c === 0 && await countJobs('spike.tx') === 1);

// 3. stately queue keyed by singletonKey: second send while one is queued is rejected (returns null).
await boss.createQueue('spike.stately', { policy: 'stately' });
const a = await boss.send('spike.stately', {}, { singletonKey: 'binding:1' });
const b = await boss.send('spike.stately', {}, { singletonKey: 'binding:1' });
const c = await boss.send('spike.stately', {}, { singletonKey: 'binding:2' });
check('stately: duplicate per key suppressed, other key accepted', !!a && b === null && !!c, `a=${!!a} b=${b} c=${!!c}`);

// 4. At-least-once: a worker that "crashes" (never completes) gets the job again after expiry.
await boss.createQueue('spike.alo', { expireInSeconds: 2, retryLimit: 3, retryDelay: 0 });
await boss.send('spike.alo', { n: 1 });
let deliveries = 0;
const [first] = await boss.fetch('spike.alo');
deliveries += first ? 1 : 0;          // simulate crash: never complete/fail
await sleep(4000);
await boss.supervise?.();             // nudge maintenance if exposed (version-dependent)
for (let i = 0; i < 20 && deliveries < 2; i++) {
  const [again] = await boss.fetch('spike.alo');
  if (again) { deliveries++; await boss.complete('spike.alo', again.id); }
  else await sleep(1000);
}
check('at-least-once: expired job redelivered', deliveries >= 2, `deliveries=${deliveries}`);

// 5. key_strict_fifo: same key processed in order.
await boss.createQueue('spike.fifo', { policy: 'key_strict_fifo' });
for (const n of [1, 2, 3]) await boss.send('spike.fifo', { n }, { singletonKey: 'run:42' });
const order = [];
for (let i = 0; i < 10 && order.length < 3; i++) {
  const jobs = await boss.fetch('spike.fifo', { batchSize: 3 });
  for (const j of jobs) { order.push(j.data.n); await boss.complete('spike.fifo', j.id); }
  if (!jobs.length) await sleep(300);
}
check('key_strict_fifo: in-order per key', order.join(',') === '1,2,3', `order=${order}`);

await boss.stop({ graceful: true });
await pool.end();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
