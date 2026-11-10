# T-P0-02 — pg-boss 12 + Drizzle transactional send — 2026-11-10

**Run:** `node run-embedded.mjs` (embedded PostgreSQL **18.6** on Windows, no Docker; Node 24.18, pg-boss 12.38.1, drizzle-orm 0.45.4, pg 8.23.1).

| Check | Result |
|---|---|
| Commit: domain row and job become visible together (`boss.send(..., { db: fromDrizzle(tx, sql) })`) | PASS |
| Rollback: neither row nor job remains | PASS |
| `stately` queue: second send with the same `singletonKey` returns `null`; another key is accepted | PASS |
| At-least-once: a fetched job that is never completed is delivered again after `expireInSeconds` | PASS (2 deliveries) |
| `key_strict_fifo`: jobs with one key are processed in order | PASS (1,2,3) |

**Conclusions**
- Transactional enqueue works with the built-in `fromDrizzle` adapter. No custom `executeSql` wrapper is needed.
- Delivery is at-least-once, as assumed. Idempotent consumers remain mandatory.
- OD-09 stays "NestJS 12", but the Nest application-context wiring itself is only proven in P1 (T-P1-06). This spike ran in plain Node.

**Caveats**
- Ran on PostgreSQL 18.6 (what the embedded package ships), not the planned 17 image. Repeat on `pgvector/pgvector:0.8.7-pg17` once Docker exists. No behaviour difference is expected.

## Docker rerun — 2026-11-10
`npm run db:up && npm run spike` against `pgvector/pgvector:0.8.7-pg17` (PostgreSQL 17.11): **5/5 PASS**, same as above. `CREATE EXTENSION vector` works and reports 0.8.7. The PG 18 caveat is closed.
