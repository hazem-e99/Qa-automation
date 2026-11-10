# QualityOS — Implementation status

> Statuses: `planned` → `in_progress` → `implemented` (code and tests exist) → `verified` (the task's Verify criterion in [26](../planning/26-task-breakdown.md) was run and passed; evidence listed).
> Planning package approved by the owner: **2026-11-09**. Closed gates: [P0](gates/P0.md) (2026-11-10).

## Current phase: P1 — Monorepo and core foundation

**All 18 tasks have code. The gate is not closed:** CI has never run (nothing is pushed), and the owner has not signed off. Draft gate record: [gates/P1.md](gates/P1.md).

Last full run on 2026-11-10 (Windows 11, Node 24.18, Docker Desktop 4.99):

| Check | Result |
|---|---|
| `pnpm build` | 17/17 packages |
| `pnpm typecheck` | 29/29 tasks |
| `pnpm lint` | ESLint clean; dependency-cruiser: no violations (170 modules) |
| `pnpm format:check` | clean |
| `pnpm test` | 51 unit tests pass |
| `pnpm test:integration` | 48 tests pass on `pgvector/pgvector:0.8.7-pg17` (Testcontainers) |
| `pnpm e2e` | 10 browser tests pass (Chromium, Windows baselines) |
| `pnpm stack:up` | postgres, migrate, api, worker, web all healthy; web shows api and worker "Ready" |

| Task | Status | Evidence / what is missing |
|---|---|---|
| T-P1-01 Monorepo, tooling | **implemented** | pnpm 12.18 (corepack) + Turborepo, TS 6.0.3, ESLint, Prettier, commitlint and Knip configs. **Missing:** commitlint is not wired to a git hook; Knip has not been run clean; "CI lint green" has not been observed |
| T-P1-02 Fitness functions | **verified** | `packages/config/test/fitness.test.ts`: the failing fixture triggers all 5 dependency rules; provider-literal and RTL rules tested with RuleTester. All run in `pnpm lint` |
| T-P1-03 Contracts + kernel-domain | **implemented** | Zod contracts with JSON Schema export; UUIDv7, ProjectScope, Result/DomainError. **Missing:** OpenAPI document assembly (planned with the first product API in P2) |
| T-P1-04 Composition roots | **verified** | api, worker, execution-controller (empty). Typed config validated at boot, graceful shutdown. Boot tests for api and worker; controller checked by a manual run only |
| T-P1-05 Postgres + Drizzle | **verified** | Migrations apply on Testcontainers, are idempotent, and `drizzle-kit check` is clean. **Not done:** separate `qos_app`/migrator database roles (doc 10 §2) |
| T-P1-06 pg-boss behind `JobQueue` | **verified** | `packages/modules/probe/test/atomicity.integration.test.ts`: commit writes row + audit + outbox + job; a forced failure leaves none |
| T-P1-07 Outbox + dispatcher | **verified** | Same file: delivery, retry after a failed subscriber, no double dispatch with two dispatchers, LISTEN/NOTIFY wake-up. **Not done:** dead-lettering of an event that fails forever |
| T-P1-08 Inbox | **verified** | `packages/modules/platform/test`: unique (connection, dedupe key) rejects a redelivery; processor handles, ignores unknown types, parks a poison message after N attempts; secret headers are never stored. No provider handlers yet (P2+) |
| T-P1-09 Idempotency, operations, SSE | **verified** | Repeat-key test (module and HTTP): one execution, stored response replayed, different body refused, concurrent requests create one row. SSE test: stream sends each state and closes on the final one |
| T-P1-10 Logging, correlation, redaction | **implemented** | Log scan test for redaction; correlation id followed HTTP → outbox → job → worker log. **Missing:** OpenTelemetry hooks |
| T-P1-11 Health + Compose healthchecks | **verified** | `/healthz` and `/readyz` on all processes; Compose healthchecks green in `pnpm stack:up`; lost database gives 503 |
| T-P1-12 localfs storage + signed URLs | **verified** | Shared contract suite (`packages/contract-tests`) passes for localfs: 9 tests including traversal keys and concurrent writes. Signed link endpoint: tampered, expired, re-targeted links refused; HTML never served inline |
| T-P1-13 Compose `core`, CLI | **implemented** | `pnpm qos init`, `pnpm qos doctor`, `pnpm stack:up` work on this Windows machine. **Not verified:** "fresh-clone boot" (it was run in the working tree, not from a new clone). Image keeps dev dependencies (1.37 GB) |
| T-P1-14 Web shell | **verified** | Next.js shell with sidebar, top bar, light/dark tokens, English/Arabic with RTL, command palette stub. Playwright: 4 visual variants + 6 behaviour tests. RTL lint rule active. **Limits:** baselines exist for Windows only |
| T-P1-15 CI pipeline | **implemented** | `.github/workflows/ci.yml` written (lint, typecheck, unit, integration, web e2e, image build, Trivy, Gitleaks, OSV). **Never run:** nothing is pushed. Action versions are unverified until the first run |
| T-P1-16 Status file + gate template | **verified** | This file, [gates/TEMPLATE.md](gates/TEMPLATE.md) |
| T-P1-17 SafeHttpClient | **verified** | SSRF suite (11 tests): private/metadata/IPv6 ranges, mixed DNS answers, pinned connection, redirect re-validation, credential stripping, timeout, size cap, retries, rate limit |
| T-P1-18 API rate limiting | **verified** | Token bucket per client address; 429 with `Retry-After`; health exempt. Per-session and per-token limits need identity (P2) |

### Also built in P1 (supporting, not separate tasks)
- **Audit log** (`governance.audit_events`): monthly range partitions, SHA-256 hash chain verified under concurrent writers, UPDATE/DELETE rejected by trigger.
- **Probe module** (`packages/modules/probe`): a diagnostic command and the reference for module layering. Disabled when `NODE_ENV=production`, so the Compose stack does not expose it.

### Deviations and decisions made while building
| Item | What | Why |
|---|---|---|
| Audit table outside drizzle-kit | DDL is a hand-written migration; the Drizzle definition is for queries only | drizzle-kit cannot express partitioned tables |
| Audit chain lock | One transaction-scoped advisory lock serializes all audit writes | Gives the chain a single order. A throughput limit; revisit in P11 |
| App tests run on compiled output | `apps/*/test` import from `dist/` | Avoids a second decorator toolchain in the test runner |
| Dependency install scripts | Denied by default; only `esbuild` allowed | Supply-chain rule (doc 21) |
| `undici` added | Used by SafeHttpClient for connection pinning | Not listed in doc 08; it is Node's own HTTP client and was already a transitive dependency |
| No authentication yet | API binds to 127.0.0.1; rate limit is per address | Identity is P2. Do not expose the API beyond loopback before then |
| Provider-literal rule | Also bans `claude`, `gemini`, `openai` | Extends the doc 07 list after ADR-0019 |
| Database port 55432 | Compose publishes PostgreSQL on 127.0.0.1:55432, not 5432 | A local PostgreSQL service already uses 5432 on the pilot machine |
| One application image | api, worker, web and migrate share one image | Simpler for the pilot; per-service pruned images are a P11 item |
| Turborepo uses the pnpm on PATH (9.15) | Root commands use corepack pnpm 12.18 | `corepack enable` needs admin rights here. Works, but should be aligned |

### Not exercised
- The job and outbox path inside containers (the probe is disabled in production mode). The same code is covered by the worker integration test on the host.
- CI on GitHub, Linux screenshot baselines, a boot from a fresh clone.
- Firefox and WebKit for the shell.

### Next
Owner decisions: repository visibility before the first push; P1 gate sign-off. Then P2 (identity, projects, provider framework).
