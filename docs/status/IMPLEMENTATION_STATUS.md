# QualityOS — Implementation status

> Statuses: `planned` → `in_progress` → `implemented` (code and tests exist) → `verified` (the task's Verify criterion in [26](../planning/26-task-breakdown.md) was run and passed; evidence listed).
> Planning package approved by the owner: **2026-11-09**. Closed gates: [P0](gates/P0.md) (2026-11-10), [P1](gates/P1.md) (2026-11-10).

## Current phase: P2 — Identity, projects, provider framework, governance base (in progress, started 2026-11-10)

Owner go-ahead for P2: 2026-11-10 (chat). P2 has 44 tasks in doc 26; 19 have code after batch 6 (sync framework). Last full run on 2026-11-12: build, typecheck, lint and format clean; 81 unit and 10 browser tests pass; integration 149/149 on a clean run (see the local flakiness note below).

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
| T-P2-20 Provider registry + manifests + capability catalog | **verified** | `packages/ports` (catalog of doc 12 §2, role requirements of §3, `capabilityDiff`), `packages/modules/integrations` (`ProviderRegistry`). The registry refuses capabilities outside the catalog or of another family, and `require()` throws `CapabilityMissingError` |
| T-P2-21 Connections + SecretStore (write-only credentials) | **verified** | M03-AC-06 (for connections): the credential is stored only in the secret store; tests scan connection rows, audit rows, API responses and every API log line for it. **Limit:** the end-to-end log scan of M14-AC-07 needs the E2E suite |
| T-P2-22 Connection test + effective capabilities | **verified** | M03-AC-01 with the mock tracker: a credential without write scope yields effective capabilities without `issues.create@1`, and the role check for `issue_tracker` fails with the missing list. Rejected credential → `auth_failed`; outage → `degraded`; an untested connection never qualifies. **Limit:** proven with mock adapters only; the GitHub variant needs T-P2-27 |
| T-P2-23 ExternalRef model + snapshots + status | **verified** | One row per (connection, type, id); snapshots capped at 16 KB. M03-AC-05: retiring a connection destroys its credential and marks its refs `source_retired` with snapshots intact. **Missing:** a UI that renders retired items |
| T-P2-26 Mock adapters | **implemented** | `packages/adapters-mock`: repository and issue-tracker mocks with capability toggles and fault injection, labelled demo. Registered only when `QOS_DEMO_MODE=true` (the Compose stack sets it). **Missing:** mocks for the other families (requirements, CI, AI, orchestrator), webhook emission |
| T-P2-34 Contract test harness | **implemented** | `packages/contract-tests`: storage and source-control suites; capability-aware skips name the missing capability; fault-injection tests skip with a reason when the mode has none. Run against the mock in two configurations (19 pass, 3 skipped with reasons). **Missing:** recorded/live fixture modes, the report that generates doc 33 |
| T-P2-11 Environments | **verified** | M02-AC-05: the test login secret is stored only in the secret store; tests scan API responses, audit summaries and every API log line for it. Base URL and reset hook hosts must be on the egress allow-list (derived from the base URLs when empty). **Limit:** `is_production` is stored but only enforced once runs exist (P6) |
| T-P2-12 Bindings + capability check + history | **verified** | M02-AC-02 (with mock adapters): a connection missing required capabilities is refused with the exact missing list; wrong family is flagged. Replacing a binding ends the old row and keeps it in the history; demo connections cannot be bound to real projects. **Missing:** `legacy_sync` mode (switch flow WF-F) and M02-AC-03/04, which need syncing and defects |
| T-P2-13 Settings sections | **verified** | M02-AC-08: every change writes a history version and an audit event naming the changed fields; stale versions answer 409. Sections `testing_rules`, `execution`, `ai`, `quality`, each with full defaults. **Limit:** BR-M02-6 "AI budget increases need qa_lead or above" is met because only qa_lead and org_admin can change settings at all |
| T-P2-24 Webhook listener + verifiers + inbox writes | **verified** | M03-AC-02 with the mock repository: a redelivery of the same delivery id gives one inbox message and one `duplicate`. HMAC-SHA256, shared-token and Basic-auth verifiers (constant-time); unknown connection and wrong path token answer the same 404; bad signatures are recorded as `rejected` without a body; bodies over 1 MiB get 413; bodies are kept in object storage. The listener runs on its own port (3004) with no other routes; path token and signing secret are shown once and stored only as hash / in the secret store. **Missing:** the inbox processor that re-fetches items (needs real adapters and sync, T-P2-25) and alerting on repeated auth failures |
| T-P2-25 Sync framework | **verified** | Resumable sync test: a provider failure on page 2 keeps page 1 and its cursor; the next run continues with no duplicates and no gaps. Cursors are written in the same transaction as each page; page budget per run (`partial` re-queues); rate limits defer with the provider hint; at most one running sync per binding and stream (partial unique index + `stately` queue); breaker of doc 22 §6 (5 transient failures within 60 s, probe after 60 s). The worker polls every active stream (default 120 s) and turns webhook inbox messages into re-fetch syncs, never trusting the payload. Stream implemented: `repository.commits`. **Missing:** streams for requirements, issues and CI (with their adapters), per-stream intervals, sync lag metrics |
| All other P2 tasks | planned | Including MFA, invitations, service tokens, user administration, templates, the mapping editor, approval engine, notifications, demo seed, the GitHub/Azure DevOps/AI adapters and all P2 screens |

Acceptance criteria so far: **met** M13-AC-01, M13-AC-02, M13-AC-04, M13-AC-06, M02-AC-05, M02-AC-06, M02-AC-07, M02-AC-08, M03-AC-05. **Met with mock adapters only** M03-AC-01, M02-AC-02, M03-AC-02, M03-AC-04 (a change appears within one poll interval; shown for repository commits). **Partly** M13-AC-03 (sessions yes; API tokens do not exist yet), M03-AC-06 (connections yes; whole-suite scan later), M03-AC-08 (harness and mock adapters; no real adapters yet). Not started: M02-AC-01/03/04, M03-AC-09, M13-AC-05, M14-AC-01/03/04/07.

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
| Mock providers behind `QOS_DEMO_MODE` | Registered only when the flag is true; the Compose stack defaults it to true | Doc 11 §8: demo connections must not mix with real data. Production keeps it off |
| Connection names | Unique per organization | Makes connections unambiguous in pickers and audit |
| `/connections/{id}/role-check?role=` | Added as a read-only diff endpoint | Lets the project wizard show the capability diff before binding (M02-AC-02 groundwork) |
| Project `is_demo` flag | Added to projects; demo projects can only be created in demo mode | Doc 11 §8 rule "demo connections never on non-demo projects" needs to know which projects are demo |
| Settings history readable with `audit.read` | Not `project.read` | History shows who changed what; same audience as the audit log |
| Duplicate and rejected deliveries get their own inbox rows | Marker rows with a unique suffix on the dedupe key | M03-AC-02 asks to see one `processed` and one `duplicate`; the unique key still guarantees one real message |
| Local test servers on port 0, retries for container start | Every test server (API, webhook listener, worker health) takes an OS-chosen port; the test database helper retries container startup on `EACCES`; `pnpm test:integration` runs at most 3 suites at once | On this Windows host, local TCP connections are intermittently refused with `connect EACCES` (fixed ports, OS-chosen ports and Docker-published ports alike). No reserved-range overlap or port exhaustion was found; security software is the likely cause. Roughly one in two full local runs loses one or two tests to it; clean runs pass 149/149. CI on Linux has never shown it, so CI is the reference |
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

P2 batch 7: demo seed (T-P2-04), the governance base (approval engine T-P2-52, in-app notifications T-P2-54, credential-expiry job T-P2-31), then the GitHub adapter (T-P2-27) and the P2 screens. Still carried from P1: commitlint git hook and a clean Knip run.
