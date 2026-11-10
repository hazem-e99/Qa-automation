# ADR-0006 — pg-boss instead of Redis/BullMQ
- Status: Accepted · Date: 2026-11-09 · Deciders: Principal Architect, Platform Engineer

## Context
Background work includes sync polling, document parsing, AI tasks, run coordination, outbox dispatch, and maintenance. Volume is low: hundreds to a few thousand jobs per day per company. Correctness matters more than throughput. In particular, **a job and the domain state change that caused it must commit atomically**.

## Decision
Use **pg-boss v12** ([36 Q1–Q7](../36-technical-validation.md)) on the primary Postgres database.

- Jobs are sent in the same transaction as the state change, through the Drizzle `db` adapter.
- Each queue gets a deliberately chosen policy ([17 §3](../17-test-execution-engine.md); consumer rules in [22 §4](../22-observability-and-reliability.md)).
- Each queue family has a dead-letter queue. Retries use exponential backoff.
- Delivery is **at-least-once**, so every consumer must be idempotent.
- Code depends on a `JobQueue` port, not on pg-boss directly. BullMQ or a broker can replace it later.

pg-boss only *coordinates* work. It **does not run browser tests**: the execution controller consumes run jobs and manages the sandboxes ([ADR-0010](ADR-0010-sandboxed-execution.md)).

## Alternatives considered
- **Redis + BullMQ**: richer features and higher throughput, but it adds a stateful service. It also cannot enqueue atomically with Postgres state, so every job would need an outbox relay.
- **Graphile Worker**: also Postgres-native, but it lacks the queue policies (`stately`, `key_strict_fifo`), dead-letter queues, and cron that we rely on.

## Consequences
- (+) No Redis to run. Enqueueing is atomic. Jobs can be inspected with SQL.
- (−) Queue load lands on the primary database. This is fine at our volume; we monitor it with `warningQueueSize` and database metrics.

## Revisit when
Load stays above roughly 50 jobs/s, or job tables start causing contention in the database.
