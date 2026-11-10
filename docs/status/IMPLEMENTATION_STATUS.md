# QualityOS — Implementation status

> Statuses: `planned` → `in_progress` → `implemented` (code and tests exist) → `verified` (the task's Verify criterion in [26](../planning/26-task-breakdown.md) was run and passed; evidence listed).
> Planning package approved by the owner: **2026-11-09**. Closed gates: [P0](gates/P0.md) (2026-11-10).

## Current phase: P1 — Monorepo and core foundation (in progress, started 2026-11-10)

Last full run on 2026-11-10 (Windows 11, Node 24.18, Docker Desktop 4.99):
`pnpm build` 11/11 · `pnpm typecheck` 19/19 · `pnpm lint` clean (ESLint + dependency-cruiser, 63 modules) · `pnpm format:check` clean · `pnpm test` 19 unit tests · `pnpm test:integration` 24 tests on `pgvector/pgvector:0.8.7-pg17` via Testcontainers.

| Task | Status | Evidence / what is missing |
|---|---|---|
| T-P1-01 Monorepo, tooling | **implemented** | pnpm 12.18 (corepack) + Turborepo, TS 6.0.3 configs, ESLint, Prettier, commitlint and Knip configs. **Missing:** commitlint is not wired to a git hook; Knip has not been run clean; "CI lint green" needs T-P1-15 |
| T-P1-02 Fitness functions | **verified** | `packages/config/test/fitness.test.ts`: failing fixture triggers all 5 dependency rules and the default reporter exits non-zero; clean fixture passes; provider-literal rule tested with RuleTester. Both run in `pnpm lint` |
| T-P1-03 Contracts + kernel-domain | **implemented** | Zod contracts with JSON Schema export, UUIDv7, ProjectScope, Result/DomainError, event envelope; 7 unit tests. **Missing:** OpenAPI document assembly (planned with the first product API in P2) |
| T-P1-04 Composition roots | **verified** | api (Nest + Fastify), worker (Nest app context), execution-controller (empty). Typed config validated at boot, graceful shutdown. Boot tests: `apps/api/test`, `apps/worker/test`; controller checked by a manual smoke run only |
| T-P1-05 Postgres + Drizzle | **verified** | `packages/db`: migrations apply on Testcontainers and are idempotent; extensions vector/pg_trgm/citext; schemas `platform`, `governance`. **Not done:** separate `qos_app`/migrator roles (doc 10 §2) — single role for now |
| T-P1-06 pg-boss behind `JobQueue` | **verified** | `packages/modules/probe/test/atomicity.integration.test.ts`: commit writes row + audit + outbox + job; forced failure leaves none. Queue registry with policies; unknown queues rejected |
| T-P1-07 Outbox + dispatcher | **verified** | Same test file: delivery to internal subscribers, retry after a failed subscriber, no double dispatch with two dispatchers, LISTEN/NOTIFY wake-up. **Not done:** dead-lettering of an event that fails forever (it is retried on every wake-up) |
| T-P1-08 Inbox | planned | |
| T-P1-09 Idempotency middleware, operations, SSE | planned | |
| T-P1-10 Logging, correlation, redaction | **implemented** | pino logger with key and pattern redaction (log scan test), correlation id HTTP → outbox → job → worker log (integration + smoke). **Missing:** OpenTelemetry hooks |
| T-P1-11 Health endpoints | **implemented** | `/healthz` and `/readyz` on all three processes, tested including a lost database (503). **Missing:** Compose healthchecks for the app services (need T-P1-13) |
| T-P1-12 localfs ObjectStorage | planned | Port interface exists in `packages/ports` |
| T-P1-13 Compose `core`, `.env.example`, `qos init`, `qos doctor` | in_progress | Only the `db` profile and `.env.example` exist. No Dockerfiles, no CLI |
| T-P1-14 Web shell | planned | |
| T-P1-15 CI pipeline | planned | No git remote yet |
| T-P1-16 Status file + gate template | **verified** | This file and [gates/TEMPLATE.md](gates/TEMPLATE.md) |
| T-P1-17 SafeHttpClient | planned | |
| T-P1-18 API rate limiting | planned | |

### Also built in P1 (supporting, not separate tasks)
- **Audit log** (`governance.audit_events`): monthly range partitions (current and next month created by the migrator), SHA-256 hash chain verified under concurrent writers, UPDATE/DELETE rejected by trigger.
- **Probe module** (`packages/modules/probe`): a diagnostic command and the reference for module layering. It exists to prove the transaction guarantees and is disabled when `NODE_ENV=production`.

### Deviations and decisions made while building
| Item | What | Why |
|---|---|---|
| Audit table outside drizzle-kit | DDL is a hand-written migration; the Drizzle definition is for queries only | drizzle-kit cannot express partitioned tables. `drizzle-kit check` therefore does not cover it |
| Audit chain lock | One transaction-scoped advisory lock serializes all audit writes | Gives the chain a single order. A throughput limit; revisit in P11 |
| App tests run on compiled output | `apps/*/test` import from `dist/` | Avoids a second decorator toolchain in the test runner; tests exactly what runs in production |
| Dependency install scripts | Denied by default; only `esbuild` allowed | Supply-chain rule (doc 21). `ssh2`/`cpu-features`/`protobufjs` scripts are optional native speed-ups |
| No authentication yet | API binds to 127.0.0.1; probe routes are unauthenticated | Identity is P2. Do not expose the API beyond loopback before then |
| Provider-literal rule | Also bans `claude`, `gemini`, `openai` | Extends the doc 07 list after ADR-0019 |
| Turborepo runs scripts with the pnpm on PATH (9.15) | Root commands use corepack pnpm 12.18 | `corepack enable` needs admin rights on this machine. Works, but should be aligned |

### Next in P1
T-P1-09 (idempotency + operations + SSE) → T-P1-08 (inbox) → T-P1-12 (localfs storage) → T-P1-17/18 (SafeHttpClient, rate limiting) → T-P1-14 (web shell) → T-P1-13 (Compose `core`, CLI) → T-P1-15 (CI) → P1 gate.
