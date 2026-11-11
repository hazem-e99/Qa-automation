# QualityOS — Implementation status

> Statuses: `planned` → `in_progress` → `implemented` (code and tests exist) → `verified` (the task's Verify criterion in [26](../planning/26-task-breakdown.md) was run and passed; evidence listed).
> Planning package approved by the owner: **2026-11-09**. Closed gates: [P0](gates/P0.md) (2026-11-10), [P1](gates/P1.md) (2026-11-10).

## Current phase: P2 — Identity, projects, provider framework, governance base (in progress, started 2026-11-10)

Owner go-ahead for P2: 2026-11-10 (chat). P2 has 49 tasks; batches 1 (identity core) and 2 (secret store, projects, memberships) are built. Last full run on 2026-11-11: build, typecheck, lint and format clean; 59 unit, 100 integration and 10 browser tests pass locally; `pnpm stack:up` healthy and exercised by hand (setup, login, CSRF, create project).

| Task | Status | Evidence / what is missing |
| --- | --- | --- |
| T-P2-01 Users, local auth, sessions, CSRF, login rate limit | **implemented** | `packages/modules/identity`, `apps/api/test/auth.integration.test.ts`. argon2id; opaque session token stored only as a hash; idle (8 h) and absolute (7 d) timeouts; CSRF token bound to the session; 5 login attempts per minute per account and per address; one generic error for every login failure. First administrator is created through a one-time setup endpoint guarded by a setup token. **Missing:** password change/reset, session rotation on privilege change, account lockout beyond the rate limit, breached-password list |
| T-P2-40 Roles/permissions catalog + seed | **verified** | M13-AC-06: `rbac.test.ts` compares the matrix rendered from the catalog with the table in `docs/planning/modules/M13-team-permissions.md`, cell by cell. Catalog is synchronized to the database at API start |
| T-P2-41 Policy guard + route declaration test | **verified** | M13-AC-01: `route inventory` test lists every route and fails on a missing declaration; a route without one is refused at runtime. Only 5 routes are public (health ×2, login, setup, signed file links). **Limit:** permission checks are org-scope only until projects exist |
| T-P2-45 `/me/permissions` | **implemented** | Org-scope at `/me/permissions`, project-scope at `/projects/{key}/permissions`. **Missing:** the UI gating helper (no UI uses it yet) |
| T-P2-51 SecretStore + envelope adapter + master key | **verified** | `packages/adapters-secrets-db`: AES-256-GCM per-secret data key wrapped with AES-KW; reference bound as authenticated data. Tests: database dump contains no secret, tampered and swapped rows are detected, wrong key cannot read, master key rotation re-wraps. Start-up refusal test: production does not start without a readable key file. `qos init` creates `secrets/master.key` (gitignored); Compose mounts it as a secret. **Limits:** nothing stores secrets yet (connections are next); no `secret_versions` table; key backup is manual |
| T-P2-10 Projects aggregate, key sequences, lifecycle | **verified** | M02-AC-06: a PATCH changing the key answers 422. M02-AC-07: archived project answers 409 `project_archived` on writes and leaves default lists. Sequences are unique and gap-free under 20 concurrent callers. **Limits:** `draft` status and templates are unused; no project-owned resources exist yet, so "all write endpoints" means the 4 that exist |
| T-P2-18 Archive / restore / delete | **implemented** | Expected-state transitions with audit and outbox events; deleted keys stay reserved. **Missing:** the "no active runs" precondition (no runs exist yet) and the 30-day purge job |
| T-P2-42 Project memberships | **implemented** | API only. M13-AC-02: for every project route, a member of project A gets the same 404 for project B as for a project that does not exist. M13-AC-04: a lead cannot change their own role or assign org roles. The last lead cannot be removed. **Missing:** the members UI; BR-M13-4 (last `org_admin`) needs user administration (T-P2-44) |
| All other P2 tasks | planned | Including MFA, invitations, service tokens, user administration, environments, bindings, settings, provider registry and connections, approval engine, notifications, mock adapters, the provider adapters and all P2 screens |

Acceptance criteria so far: **met** M13-AC-01, M13-AC-02, M13-AC-04, M13-AC-06, M02-AC-06, M02-AC-07. **Partly** M13-AC-03 (sessions yes; API tokens do not exist yet). Not started: M02-AC-01…05/08, M03-*, M13-AC-05, M14-AC-01/03/04/07.

### Decisions made in P2 so far
| Item | What | Why |
| --- | --- | --- |
| `project.create` permission | Added to the org-scope list in M13 (org_admin) | The matrix had no permission for creating a project; needed by the project wizard |
| "Policy-dependent" grants (◐) | Treated as denied | The approval policy engine (T-P2-52) does not exist yet |
| First user gets `org_admin` and `platform_admin` | Single-organization pilot | One person operates and administers the pilot |
| Authorization source | Decisions come from the catalog in code; the database tables mirror it | Keeps the documented matrix, the code and the data from drifting apart |
| Web shell has no login screen yet | The API is protected; the shell's only page (system status) calls public health endpoints | UI for sign-in arrives with the users/projects screens |
| Project creator becomes `qa_lead` | Added as the first member in the same transaction | A project is never without someone who can manage it; `org_admin` alone cannot do test work (BR-M13-2) |
| Project deletion permission | Uses `project.settings.manage` | The matrix has no separate delete permission |
| Master key outside production | Optional in `development` and `test`; the secret store is then absent, never a plaintext fallback | Lets tests and local host runs start without key material |
| `/me/permissions?projectKey=` | Implemented as `/projects/{key}/permissions` | Goes through the same project guard, so it cannot leak project existence |
| `argon2` install script denied | The package ships prebuilt binaries | Keeps the deny-by-default rule for install scripts |
| Probe endpoints | Now need `system.settings` (platform admin) | They were unauthenticated in P1 |

## P1 — Monorepo and core foundation (closed 2026-11-10)

All 18 tasks have code and CI is green. Gate record: [gates/P1.md](gates/P1.md). Items marked **implemented** below have known gaps that were carried forward, not closed.

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
| T-P1-15 CI pipeline | **verified** | `.github/workflows/ci.yml` written (lint, typecheck, unit, integration, web e2e, image build, Trivy, Gitleaks, OSV). All five jobs passed on GitHub on 2026-11-10 (run 42905492449, commit `e3047e9`). Trivy and OSV-Scanner are report-only: they do not fail the build, and their findings have not been triaged |
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
- A boot from a fresh clone. Linux screenshot baselines are created in CI on each run and uploaded as an artifact; none are committed, so CI does not yet compare screenshots.
- Firefox and WebKit for the shell.

### Next

P2 batch 3: provider registry and capability catalog (T-P2-20), connections with write-only credentials (T-P2-21…23), mock adapters (T-P2-26) and the contract harness (T-P2-34). Then environments, bindings and settings, then the P2 screens. Still carried from P1: commitlint git hook and a clean Knip run.
