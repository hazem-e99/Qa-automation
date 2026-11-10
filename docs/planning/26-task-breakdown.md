# 26 — Engineering Task Breakdown

> Status: **Planned** · Owner: Staff Full-Stack Engineer · Roadmap: [25](25-implementation-roadmap.md)

Each task is small enough to finish and verify on its own. Most are under 2 days; tasks marked L take 3–5 days and should be split again during sprint planning if needed.

Every task inherits the **Definition of Done** in [24 §12](24-testing-strategy.md). "Verify" names the acceptance criteria or test that proves the task is complete.

Columns: **ID** · **Task** · **Area** (main package or file ownership) · **Deps** · **Verify** · **Size** (S ≤ 1 day, M ≤ 2 days, L ≤ 5 days).

## P0 — Spikes
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P0-01 | Assemble the 30-file AR/EN corpus (synthetic and personal documents only) with gold annotations, then run the parser bake-off (Docling vs Tika+Tesseract vs unstructured) and measure the [14 §7](14-requirements-engine.md) metrics | `spikes/parser`, `fixtures/documents` | — | Report with metrics; OD-02 decided | L |
| T-P0-02 | pg-boss 12 + Drizzle transactional send in NestJS app context; rollback test | `spikes/queue` | — | Commit/rollback proof | S |
| T-P0-03 | n8n CE: pin version; CLI import/export with stable IDs; activation; `/healthz`; public API availability; Code-node HMAC; env var names | `spikes/n8n` | — | Documented answers (N4–N6) | M |
| T-P0-04 | Sandbox on Windows/Docker Desktop: pwuser+seccomp+shm+ro rootfs; egress proxy ACL reload; socket proxy restrictions; 50-run stability | `spikes/sandbox` | — | 50/50 runs; escape checks | L |
| T-P0-05 | Version pinning & compatibility matrix (Node, NestJS 11/12, Next.js, Drizzle, pg-boss, Playwright images, licenses) | `docs/planning/36` | — | 36 updated; OD-09 decided | M |
| T-P0-06 | AI structured output on suggestion samples (run on Gemini, ADR-0019); cost and embeddings provider choice carried to T-P5-08 | `spikes/ai` | — | ≥95% schema-valid; cost table | M |

## P1 — Foundation
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P1-01 | Monorepo: pnpm workspaces, Turborepo, TS configs, ESLint/Prettier, commitlint, Knip | root, `packages/config` | P0 | CI lint green | S |
| T-P1-02 | dependency-cruiser rules + provider-literal lint rule (fitness functions) | `packages/config` | 01 | Failing fixture detected | S |
| T-P1-03 | `@qos/contracts` scaffolding (Zod → OpenAPI/JSON Schema export) + `@qos/kernel-domain` value objects | `packages/contracts`, `kernel-domain` | 01 | Unit tests | M |
| T-P1-04 | NestJS composition roots: api, worker, controller (empty), typed config validation, graceful shutdown | `apps/*` | 03 | Boot tests | M |
| T-P1-05 | Postgres + Drizzle setup, migration runner `migrate`, extensions (vector, pg_trgm, citext), schemas per module | `packages/db` | 04 | Migrations apply on Testcontainers | M |
| T-P1-06 | pg-boss bootstrap behind `JobQueue` port, transactional send helper, queue registry with policies | `packages/modules/jobs` | 05 | Atomicity integration test | M |
| T-P1-07 | Outbox table + dispatcher skeleton (internal subscribers only) + LISTEN/NOTIFY wakeup | `jobs` | 06 | At-least-once + dedupe test | M |
| T-P1-08 | Inbox table + generic processor skeleton | `integrations` (base) | 05 | Dedupe unique test | S |
| T-P1-09 | Idempotency middleware + `idempotency_keys` + `operations` API + SSE channel | `api` | 05 | Repeat-key test; SSE test | M |
| T-P1-10 | Structured logging (pino), correlation ID propagation (HTTP→jobs), redaction layer, OTel hooks | `packages/observability` | 04 | Log scan test | M |
| T-P1-11 | Health/readiness endpoints per process + Compose healthchecks | `apps/*`, `infra/compose` | 04 | Compose up green | S |
| T-P1-12 | localfs `ObjectStorage` adapter + signed URL file endpoint | `adapters-storage-localfs` | 03 | Contract test (storage) | M |
| T-P1-13 | Compose `core` profile, `.env.example`, `qos init` secrets generator, `qos doctor` (initial checks) | `infra/compose`, `tools/cli` | 11 | Fresh-clone boot on Windows | M |
| T-P1-14 | Web shell: Next.js app, layout (sidebar/topbar), tokens (light/dark), next-intl, RTL lint, command palette stub | `apps/web`, `packages/ui` | 03 | Visual tests 4 variants | L |
| T-P1-15 | CI pipeline: lint, typecheck, unit, integration (Testcontainers), build images, Trivy, Gitleaks, OSV | `.github/workflows` (or GitLab CI later) | 01 | Green pipeline | M |
| T-P1-16 | `docs/status/IMPLEMENTATION_STATUS.md` + gate template | `docs/status` | — | Exists | S |
| T-P1-17 | `SafeHttpClient` (SSRF guard with DNS pinning and redirect re-validation, timeouts, retries, per-connection rate limiter) used by all adapters | `packages/kernel-infra` | 04 | SSRF suite (initial) | M |
| T-P1-18 | API rate limiting (per session/token/IP, 429 + Retry-After) | `api` | 09 | Tests | S |

## P2 — Identity, projects, provider framework, governance base
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P2-01 | Users, local auth (argon2id), sessions, CSRF, login rate-limit | `modules/identity` | P1 | Auth tests | M |
| T-P2-02 | TOTP MFA (optional per user; enforceable later) | `identity` | 01 | Tests | S |
| T-P2-03 | Invitations (email link via in-app copy/SMTP) | `identity` | 01 | Tests | S |
| T-P2-04 | Demo seed + mock connections + `QOS_DEMO_MODE` | `tools/seed`, `adapters-mock` | 26 | Demo E2E boots | M |
| T-P2-05 | Local Git repository adapter (read/commits/diff; archive streaming) | `adapters-local-git` | 20,34 | Contract (source control) | M |
| T-P2-10 | Projects aggregate, key sequences, status lifecycle | `modules/projects` | 40 | M02-AC-06/07 | M |
| T-P2-11 | Environments (allowed hosts validation, secrets refs) | `projects` | 10,51 | M02-AC-05 | S |
| T-P2-12 | Bindings + capability check + history | `projects` | 10,22 | M02-AC-02/03/04 | M |
| T-P2-13 | Settings sections (typed, versioned, history) | `projects` | 10 | M02-AC-08 | M |
| T-P2-14 | Templates + clone configuration | `projects` | 13 | Tests | S |
| T-P2-15 | Project creation wizard UI | `apps/web` | 12,13 | M02-AC-01 (E2E) | L |
| T-P2-16 | Project settings UI (tabs) | `apps/web` | 13 | E2E | M |
| T-P2-17 | Bindings health-check job + panel | `projects`,`integrations` | 12,31 | Tests | S |
| T-P2-18 | Archive/restore/delete flows | `projects` | 10 | M02-AC-07 | S |
| T-P2-19 | Project overview page | `apps/web` | 17 | E2E | M |
| T-P2-20 | Provider registry + manifest types + capability catalog | `packages/ports`, `integrations` | P1 | Unit | M |
| T-P2-21 | Connections + SecretStore integration (write-only creds) | `integrations` | 20,51 | M03-AC-06 | M |
| T-P2-22 | Connection test + effective capabilities | `integrations` | 21 | M03-AC-01 | M |
| T-P2-23 | ExternalRef model + snapshots + status | `integrations` | 20 | M03-AC-05 | S |
| T-P2-24 | Webhook listener (separate port) + verifiers (HMAC/token/basic) + inbox writes | `integrations`, `api` | P1-08 | M03-AC-02 + webhook suite | M |
| T-P2-25 | Sync framework: cursors, runs, errors, `stately` queues, breaker, rate-limit budget | `integrations` | 20 | Resumable sync test | L |
| T-P2-26 | Mock adapters for all families (toggles, faults, webhook emission) | `adapters-mock` | 20 | Contract (mock mode) | L |
| T-P2-27 | GitHub repository adapter (read, commits, diff, branch, push via publisher, PR, protection, clone archive proxy) | `adapters-github` | 20,34 | Contract (recorded) | L |
| T-P2-28 | Azure DevOps connection: `pat` strategy (org-scoped validation, expiry), `entra` strategy skeleton | `adapters-azure-devops` | 20 | Connection test (recorded) | M |
| T-P2-29 | Claude connection test (AI family stub for P5) | `adapters-ai-anthropic` | 20 | Recorded test | S |
| T-P2-30 | Integration Hub UI (home, catalog, setup wizard, detail tabs) | `apps/web` | 22 | E2E J1 | L |
| T-P2-31 | Health + credential expiry jobs + notifications | `integrations` | 22,54 | M03-AC-07 | S |
| T-P2-32 | Mapping editor + lint | `integrations`, `apps/web` | 22 | M03-AC-09 | M |
| T-P2-33 | Retire connection + impact analysis | `integrations` | 23 | M03-AC-05 | S |
| T-P2-34 | Contract test harness (modes mock/recorded/live; capability-aware skips; report) | `packages/contract-tests` | 20 | M03-AC-08 | M |
| T-P2-40 | Roles/permissions catalog + seed (matrix) | `identity` | P1 | M13-AC-06 | S |
| T-P2-41 | Policy guard + route declaration lint test | `api` | 40 | M13-AC-01 | M |
| T-P2-42 | Project memberships + members UI | `identity`, `apps/web` | 41,10 | M13-AC-02/04 | M |
| T-P2-43 | Service accounts + API tokens (scopes, expiry, prefix) | `identity` | 41 | M13-AC-05 | M |
| T-P2-44 | Users admin UI (invite, deactivate) | `apps/web` | 01,03 | M13-AC-03 | M |
| T-P2-45 | `/me/permissions` + UI gating helper | `api`,`apps/web` | 41 | Tests | S |
| T-P2-46 | Isolation test harness (route enumeration × foreign project) | `tests/isolation` | 41 | Suite green | M |
| T-P2-50 | Audit events + interceptor + monthly partitions + DB privileges | `modules/governance` | P1 | M14-AC-01 | M |
| T-P2-51 | SecretStore port + envelope adapter + master key handling | `governance`, `adapters-secrets-db` | P1 | Unit + startup refusal test | M |
| T-P2-52 | Approval policy engine core (requests/decisions, SoD, content hash, expiry) | `governance` | 50 | M14-AC-03/04 | L |
| T-P2-53 | My approvals inbox UI | `apps/web` | 52 | E2E | M |
| T-P2-54 | In-app notifications + preferences | `governance` | 50 | Tests | M |
| T-P2-55 | System health endpoint (basic) + page | `governance`, `apps/web` | P1-11 | E2E | S |
| T-P2-56 | Audit explorer UI | `apps/web` | 50 | E2E | M |

## P3 — Requirements ingestion
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P3-01 | Requirements aggregate, versions (immutable trigger), AC, keys | `modules/requirements` | P2 | Unit/integration | M |
| T-P3-02 | Requirement sources CRUD | `requirements` | 01 | Tests | S |
| T-P3-03 | Manual entry API + editor UI (TipTap, RTL) | `requirements`, `apps/web` | 01 | E2E | M |
| T-P3-04 | Upload pipeline: validation (magic bytes, caps, encryption, zip-bomb), storage, snapshot dedupe | `requirements` | P1-12 | M04-AC-08 | M |
| T-P3-05 | Parser service (chosen lib) + `ParsedDocument` contract + isolation config | `services/parser` | P0-01 | Parser contract on corpus | L |
| T-P3-06 | Deterministic extraction rules (IDs, modals EN/AR, AC patterns, tables) | `requirements` | 05 | Extraction metrics report | L |
| T-P3-07 | Spreadsheet column mapping (saved per source) | `requirements` | 04 | Tests | M |
| T-P3-08 | Extraction review workspace UI (split view, keyboard) | `apps/web` | 06,14 | E2E J2 (no AI) | L |
| T-P3-09 | Approval workflow integration (policy engine) + inferred safeguards | `requirements` | P2-52 | M04-AC-02 (non-AI part), M04-AC-05 | M |
| T-P3-10 | Azure Boards RequirementsSource adapter (WIQL, batch get, relations, rev, HTML→MD) | `adapters-azure-devops` | P2-25 | Contract (recorded) + M04-AC-03 | L |
| T-P3-11 | Snapshot diffing (requirement + AC level) + matching rules | `requirements` | 06 | M04-AC-04 | M |
| T-P3-12 | Traceability links base + requirement trace view | `modules/traceability`, `apps/web` | 01 | Tests | M |
| T-P3-13 | Arabic normalization + search (FTS simple + trigram) | `requirements` | 01 | M04-AC-06 | M |
| T-P3-14 | Source viewer (PDF render, sanitized DOCX HTML, sheet grid) | `apps/web`, `api` | 05 | E2E | M |
| T-P3-15 | Requirements list/detail UI (versions, provenance, history) | `apps/web` | 01 | E2E | M |
| T-P3-16 | Requirements & traceability export (XLSX/CSV) | `requirements` | 12 | Tests | S |

## P4 — Test management, manual workspace, internal defects
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P4-01 | Test case aggregate, versions, steps, immutability | `modules/testmgmt` | P3 | M05-AC-03 | M |
| T-P4-02 | Suites (static/dynamic query) | `testmgmt` | 01 | Tests | M |
| T-P4-03 | Requirement links (AC granularity) + outdated handling | `testmgmt`,`traceability` | 01,P3-12 | M05-AC-04 | M |
| T-P4-04 | Test case editor UI (step grid, keyboard) | `apps/web` | 01 | E2E | L |
| T-P4-05 | Library UI + bulk operations | `apps/web` | 02 | E2E | M |
| T-P4-06 | Import CSV/XLSX with mapping + formula neutralization | `testmgmt` | 01 | M05-AC-07 | M |
| T-P4-07 | Shared steps (versioned) | `testmgmt` | 01 | Tests | M |
| T-P4-08 | Approval flow + review queue for human drafts | `testmgmt` | P2-52 | Tests | M |
| T-P4-09 | Quality checklist (configurable rules) | `testmgmt` | 01 | Tests | S |
| T-P4-10 | Coverage matrix query (`mv_latest_results`) + heatmap UI | `testmgmt`, `apps/web` | 03 | M05-AC-05 | M |
| T-P4-20 | Runs/executions/attempts/step results (manual kind) + state machine | `modules/execution` | 01 | Unit | M |
| T-P4-21 | Cycles + assignments | `execution` | 20 | Tests | M |
| T-P4-22 | My Queue API/UI | `execution`, `apps/web` | 21 | E2E | M |
| T-P4-23 | Step runner UI (keyboard, autosave) | `apps/web` | 20 | M06-AC-01/02 | L |
| T-P4-24 | Evidence upload pipeline + image sanitization | `execution` | P1-12 | M06-AC-08 | M |
| T-P4-25 | Offline buffer (IndexedDB) + idempotent sync | `apps/web` | 23 | M06-AC-04 | M |
| T-P4-26 | Defect draft from failed step → M10 | `execution`,`defects` | 42 | M06-AC-03 | S |
| T-P4-27 | Retest proposal on defect fix candidate | `execution` | 40 | M06-AC-06 | S |
| T-P4-28 | Exploratory sessions + notes conversion | `execution`, `apps/web` | 20 | E2E | M |
| T-P4-29 | Cycle dashboard | `apps/web` | 21 | M06-AC-07 | M |
| T-P4-30 | Execution history per test case | `apps/web` | 20 | E2E | S |
| T-P4-31 | Carry-over/clone cycles | `execution` | 21 | M06-AC-05 (reopen) + tests | S |
| T-P4-32 | Timer + manual effort capture | `execution` | 23 | Tests | S |
| T-P4-40 | Internal defect aggregate + lifecycle state machine | `modules/defects` | P3 | Unit | M |
| T-P4-41 | Defect list/board/detail UI | `apps/web` | 40 | E2E | M |
| T-P4-42 | Manual defect drafts | `defects` | 40 | Tests | S |
| T-P4-43 | Defect traceability links | `defects` | 40,P3-12 | Tests | S |
| T-P4-44 | Approval policy hook for defects | `defects` | P2-52 | Tests | S |
| T-P4-45 | Defect state history | `defects` | 40 | Tests | S |
| T-P4-46 | Internal tracker adapter (IssueTracker reference impl) | `adapters-internal-tracker` | 40 | Contract (issue tracking) | M |
| T-P4-50 | Dashboard shell + My work strip | `apps/web` | 22 | E2E | M |
| T-P4-51 | Basic summary (live queries) | `analytics` | 50 | M01-AC-03 (basic) | S |
| T-P4-52 | P4 validation: run one real manual cycle; capture time-per-execution baseline | owner | all P4 | Cycle report | S |

## P5 — AI test intelligence
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P5-01 | AI Gateway core (task registry, pipeline, persistence) | `modules/ai` | P4 | Unit/integration | L |
| T-P5-02 | Gemini adapter (structured output, retries, per-model rate limit + fallback model, usage); Claude adapter follows per ADR-0019 | `adapters-ai-gemini` | 01 | Contract (AI recorded) | M |
| T-P5-03 | Prompt registry + versioning + eval runner (recorded/live) | `packages/prompts`, `tools/evals` | 01 | Eval CI job | M |
| T-P5-04 | `tests.suggest` task + schema + eval set (40 reqs) | `prompts`, `testmgmt` | 03 | Eval ≥ thresholds | L |
| T-P5-05 | AI generation workspace UI | `apps/web` | 04 | E2E J3 | L |
| T-P5-06 | Suggestion dispositions + reason codes + metrics | `testmgmt` | 04 | M05-AC-02 | S |
| T-P5-07 | Charters / accessibility / security-check variants + safety validator | `prompts` | 04 | Safety tests | M |
| T-P5-08 | Test-case embeddings + duplicate hints (embedding provider per T-P0-06) | `ai`,`testmgmt` | 01 | Tests | M |
| T-P5-09 | Cost estimate pre-check UI + budget messages | `ai`, `apps/web` | 12 | M05-AC-08 | S |
| T-P5-10 | Redaction pipeline (packs + project rules) | `ai` | 01 | Redaction tests | M |
| T-P5-11 | AI usage ledger + budgets + price tables | `governance`,`ai` | 01 | Tests | M |
| T-P5-12 | Budget enforcement in gateway | `ai` | 11 | M14-AC-05 | S |
| T-P5-20 | `requirements.extract` (AI assist) + quote grounding validator | `requirements`, `prompts` | 01 | Extraction eval | L |
| T-P5-21 | Requirement embeddings + duplicate findings | `requirements` | 08 | M04-AC-10 | M |
| T-P5-22 | Conflict analysis (topic clusters + task) | `requirements` | 21 | M04-AC-05 + eval | M |
| T-P5-23 | Gap/ambiguity analysis | `requirements` | 01 | Eval | M |
| T-P5-24 | Findings inbox UI | `apps/web` | 22 | E2E | M |
| T-P5-25 | Impact analysis + `tests.suggest_updates` | `requirements`,`testmgmt` | P3-11 | E2E J8 | M |

## P6 — Automated test execution
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P6-01 | Run/execution/attempt/result model (automated) + state machine + immutability triggers | `execution` | P4-20 | M08-AC-08 | M |
| T-P6-02 | Run request API + idempotency + selection resolver (suite/tag/explicit/smoke/regression/failed-last) | `execution` | 01 | M08-AC-04 | M |
| T-P6-03 | Execution policy model + enforcement (API + controller) | `execution` | 02 | Tests | M |
| T-P6-04 | Compose `exec` profile: socket proxy, sandbox/egress networks, egress proxy, registry mirror | `infra/compose` | P0-04 | `doctor` checks | M |
| T-P6-05 | Execution controller: consume, claim, provision, monitor, heartbeat, reconcile, leases | `apps/execution-controller`, `adapters-backend-docker` | 04 | M08-AC-03 | L |
| T-P6-06 | Sandbox image build (per Playwright version, fonts, entrypoint) + version resolver | `infra/images/sandbox` | 04 | Image tests | M |
| T-P6-07 | Per-run tokens (archive, upload) + internal sandbox listener | `api` | 05 | Token scope tests | M |
| T-P6-08 | Sandbox entrypoint (archive fetch, npm ci via mirror, run, chunked upload, retries) | `services/sandbox-entrypoint` | 06,07 | Integration with demo repo | M |
| T-P6-09 | Playwright engine adapter (run spec, reporters, result parser, shards) | `adapters-engine-playwright` | 01 | Engine contract (recorded reports) | L |
| T-P6-10 | Artifact ingestion + storage + signed URLs + retention classes | `execution` | 07 | Tests | M |
| T-P6-11 | Live stream SSE (status, sanitized logs, progressive results) | `api`, `apps/web` | 05 | E2E | M |
| T-P6-12 | Run viewer UI + trace viewer embedding (versioned static) | `apps/web` | 10 | M08-AC-01 | L |
| T-P6-13 | Cancellation (queued/running; SIGTERM→SIGKILL) | `execution`, controller | 05 | M08-AC-07 | M |
| T-P6-14 | Binding discovery by `@tc:` tag on default branch | `execution` | P2-27 | M07-AC-07 | M |
| T-P6-15 | Flaky detection + board + quarantine | `execution` | 09 | M08-AC-02 | M |
| T-P6-16 | Run comparison | `execution`, `apps/web` | 01 | E2E | S |
| T-P6-17 | Log sanitization (secrets, patterns) | `execution` | 05 | Log scan | S |
| T-P6-18 | Preflight environment check | controller | 05 | Tests | S |
| T-P6-19 | Sandbox security test suite | `tests/security/sandbox` | 05,08 | M08-AC-05/06 | M |
| T-P6-20 | CI-delegated ingestion endpoint (Automation API) | `api` | 09 | M08-AC-10 | M |
| T-P6-21 | Disk/resource guards | controller | 05 | Tests | S |
| T-P6-22 | Runs list + new run UI | `apps/web` | 02 | E2E | M |
| T-P6-23 | Demo app fixture (EN/AR, RTL, toggleable seeded bugs, flaky and visual toggles) + its Playwright test repo + Compose service | `fixtures/demo-app`, `fixtures/demo-tests` | — | Runs in sandbox via allowlist | L |
| T-P6-24 | Container-spec guard: the controller builds the spec from a fixed template and rejects privileged mode, host binds, added capabilities, host network/PID (the socket proxy does not check request bodies; T-P0-04 finding) | controller | 05 | Unit tests per rejected field | S |

## P7 — Orchestration
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P7-01 | Outbox dispatcher (subscriptions, orchestrator target) | `modules/automation` | P1-07 | Tests | M |
| T-P7-02 | `workflow_dispatches` retries/backoff/DLQ | `automation` | 01 | Tests | M |
| T-P7-03 | Automation API (scopes, idempotency required, events fetch) | `api` | P2-43 | Contract tests | M |
| T-P7-04 | Automation rules + versions + template registry | `automation` | 01 | Tests | M |
| T-P7-05 | Firing claim endpoint + slot computation (RRULE/tz) + `schedules/due` | `automation` | 04 | M11-AC-01 | M |
| T-P7-06 | Fallback scheduler job | `automation` | 05,08 | M11-AC-02 | M |
| T-P7-07 | Automation runs + callbacks + reaper | `automation` | 01 | M11-AC-04 | M |
| T-P7-08 | Orchestrator health probe + status events | `adapters-orchestrator-n8n` | — | Tests | S |
| T-P7-09 | n8n Compose service + import/export/sanitize scripts | `infra/compose`, `infra/scripts` | P0-03 | Scripts run in CI | M |
| T-P7-10 | 14 workflow templates with HMAC verification + idempotency headers | `infra/n8n/workflows` | 03,09 | Template tests | L |
| T-P7-11 | Rule editor UI + dry-run | `apps/web` | 04 | M11-AC-07 | M |
| T-P7-12 | Automation runs UI | `apps/web` | 07 | E2E | M |
| T-P7-13 | Orchestrator status + DLQ UI | `apps/web` | 08,02 | E2E | S |
| T-P7-14 | Template drift detection | `automation` | 09 | M11-AC-08 | S |
| T-P7-15 | Catch-up policy | `automation` | 06 | M11-AC-05 | S |
| T-P7-16 | Notification delivery via n8n + delivered callbacks | `governance`, templates | 10 | M11-AC-03 | M |
| T-P7-17 | Resilience test suite (n8n kill, core kill, sleep) | `tests/resilience` | 06,07 | Suite green | M |
| T-P7-18 | Containerized n8n template contract tests (nightly) | `tests/workflows` | 10 | M11-AC-06 | M |

## P8 — Defect intelligence & issue sync
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P8-01 | Deterministic failure signal extractor | `defects` | P6 | Unit on fixtures | M |
| T-P8-02 | `failures.classify` task + 150-failure eval set | `prompts`, `defects` | 01,P5-01 | Eval thresholds | L |
| T-P8-03 | Clustering (signatures + merge task) | `defects` | 01 | M10-AC-02 | M |
| T-P8-04 | Defect embeddings + duplicate candidates + judge task | `defects` | P5-08 | Eval | M |
| T-P8-05 | `defects.draft` task | `defects`, `prompts` | 03 | Rubric eval | M |
| T-P8-06 | Draft review UI | `apps/web` | 05 | E2E | L |
| T-P8-07 | External push with idempotent marker recovery | `defects` | 10/11 | M10-AC-04 | M |
| T-P8-08 | Status/field/type mapping application (both directions) | `defects`,`integrations` | P2-32 | Mapping tests | M |
| T-P8-09 | Issue tracker sync poll + lifecycle updates | `defects` | 08 | Tests | M |
| T-P8-10 | Azure Boards IssueTracker adapter (JSON Patch, metadata, tags marker, rev concurrency) | `adapters-azure-devops` | P2-28 | Contract (recorded) + M10-AC-05 | L |
| T-P8-11 | GitHub Issues adapter (labels mapping, search marker) | `adapters-github` | P2-27 | Contract (recorded) | M |
| T-P8-12 | Fix detection (commit patterns, PR links, external resolved) | `defects` | P2-27 | M10-AC-06 | M |
| T-P8-13 | Verification orchestration (retest creation, build ≥ fix rule) | `defects`, `automation` | 12,P7 | M10-AC-06 | M |
| T-P8-14 | Sync conflicts detection/UI | `defects` | 09 | M10-AC-07 | S |
| T-P8-15 | Quality gates + evaluation + optional CI/commit status report | `execution` | P6 | M08-AC-09 | M |
| T-P8-16 | Feedback capture → eval dataset candidates | `ai` | 02 | Tests | S |
| T-P8-17 | Environment-failure suppression + health alert | `defects` | 03 | Tests | S |
| T-P8-18 | Root-cause hints (optional: suspect commits) | `defects` | 01 | Manual review | M |

## P9 — Codegen & visual
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P9-01 | Conventions config + onboarding PR | `modules/codegen` | P6 | E2E | M |
| T-P9-02 | Deterministic skeleton generator | `codegen` | 01 | Unit | M |
| T-P9-03 | Codegen sandbox profile + publisher container (scoped write token) | controller | P6-05 | M07-AC-06 | L |
| T-P9-04 | `code.generate_test` tool loop via gateway proxy | `ai`, `codegen` | 03,P5-01 | Codegen eval | L |
| T-P9-05 | Playwright planner/generator agent integration (optional mode) | `codegen` | 04 | Manual + eval | M |
| T-P9-06 | Verification runs ×3 + PR report | `codegen` | 04 | M07-AC-01 | M |
| T-P9-07 | Diff guard (AST) | `codegen` | 02 | M07-AC-03 + adversarial corpus | M |
| T-P9-08 | PR creation + state sync | `codegen` | 06,07 | M07-AC-01/02 | M |
| T-P9-09 | Codegen jobs UI | `apps/web` | 08 | E2E | M |
| T-P9-10 | Fix proposals + healer propose mode | `codegen` | 07 | Guard tests | M |
| T-P9-11 | Binding health + notifications | `execution` | P6-14 | M07-AC-05 | S |
| T-P9-12 | Degradation (patch download) for providers without PRs | `codegen` | 08 | Mock capability toggle test | S |
| T-P9-13 | Codegen eval set (20 cases) | `tools/evals` | 04 | Eval thresholds | M |
| T-P9-14 | Cost tracking per job | `codegen`,`ai` | 04 | Tests | S |
| T-P9-20 | Visual checkpoint identity + baseline model | `modules/visual` | P6 | Unit | M |
| T-P9-21 | Baseline fetch for sandbox + pinning | `visual`, `api` | 20 | Tests | M |
| T-P9-22 | Engine visual compare integration | `adapters-engine-playwright` | 21 | M09-AC-02 | M |
| T-P9-23 | Determinism defaults + font set | images, engine | 22 | Determinism test | S |
| T-P9-24 | Diff viewer UI (side/slider/heatmap) | `apps/web` | 22 | M09-AC-02 | M |
| T-P9-25 | Review queue + actions | `visual`, `apps/web` | 24 | M09-AC-03 | M |
| T-P9-26 | Masks editor | `apps/web` | 25 | M09-AC-06 | M |
| T-P9-27 | Approval policy integration for baselines | `visual` | 25 | M09-AC-04 | S |
| T-P9-28 | RTL/viewport matrix config | `visual` | 20 | M09-AC-05 | S |
| T-P9-29 | Invalidation on image major change | `visual` | 20 | M09-AC-07 | S |
| T-P9-30 | Baseline rollback | `visual` | 25 | Tests | S |
| T-P9-31 | Visual retention | `visual` | 20 | Tests | S |
| T-P9-32 | Visual E2E on demo app | `tests/e2e` | 25 | Suite | M |

## P10 — Analytics & reporting
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P10-01 | KPI registry + versions (all [29](29-business-case-and-kpis.md) KPIs) | `modules/analytics` | P8,P9 | M12-AC-01 | M |
| T-P10-02 | Snapshot job (incremental) | `analytics` | 01 | M12-AC-04 | M |
| T-P10-03 | Metrics API | `analytics` | 02 | Tests | S |
| T-P10-04 | Project report | `analytics`, `apps/web` | 03 | E2E | M |
| T-P10-05 | Cycle/release report | `analytics` | 03 | E2E | M |
| T-P10-06 | Time-saved estimate model + assumptions UI | `analytics` | 03 | M12-AC-02 | S |
| T-P10-07 | Cost ledger rollup + cost report | `analytics` | P5-11 | M12-AC-06 | M |
| T-P10-08 | AI quality metrics | `analytics` | P8-16 | Tests | S |
| T-P10-09 | Executive summary + PDF rendering | `analytics` | 04 | M12-AC-02 | M |
| T-P10-10 | `report.narrative` + number validator | `prompts`, `analytics` | 09 | M12-AC-03 | S |
| T-P10-11 | Weekly report automation endpoint | `api` | 09 | Template test | S |
| T-P10-12 | Exports (CSV/XLSX/PDF/JSON) | `analytics` | 03 | Tests | S |
| T-P10-13 | Saved report definitions | `analytics` | 04 | Tests | S |
| T-P10-14 | KPI fixture tests | `tests` | 01 | M12-AC-01 | M |
| T-P10-15 | Arabic UI string catalog + RTL visual pass of core screens | `apps/web` | P1-14 | Visual tests RTL | L |
| T-P10-20 | Dashboard summary/trends from snapshots | `analytics` | 02 | M01-AC-01 | M |
| T-P10-21 | Projects table + risk indicator | `apps/web`, `analytics` | 20 | M01-AC-06 | M |
| T-P10-22 | Activity feed | `analytics` | 20 | Tests | S |
| T-P10-23 | Comparison view | `apps/web` | 20 | E2E | S |
| T-P10-24 | Definition popovers bound to KPI registry | `apps/web` | 01 | M01-AC-02 | S |
| T-P10-25 | Dashboard PDF export | `analytics` | 09 | Tests | S |
| T-P10-26 | Large-seed performance test | `tests/perf` | 20 | M01-AC-07 | M |

## P11 — Hardening
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P11-01 | Custom roles | `identity` | P2 | Tests | M |
| T-P11-02 | Access review report | `identity` | P2 | Tests | S |
| T-P11-03 | Break-glass elevation | `identity` | P2 | Tests | M |
| T-P11-04 | Node 26 LTS evaluation + upgrade if green | root | — | CI green on Node 26 | S |
| T-P11-05 | Resilience suite consolidation (all scenarios in [24 §10](24-testing-strategy.md)) | `tests/resilience` | P7-17 | Suite green | M |
| T-P11-06 | Runbooks (8) in `docs/runbooks` | docs | — | Reviewed | M |
| T-P11-07 | OpenAI-compatible local AI adapter (Ollama/vLLM) | `adapters-ai-openai-compatible` | P5-02 | Contract (AI) | M |
| T-P11-10 | Audit hash chain + digests + verify command | `governance` | P2-50 | M14-AC-02 | M |
| T-P11-11 | Retention policies + purge + legal hold | `governance` | — | M14-AC-08 | M |
| T-P11-12 | Backup job/scripts + encryption + UI | `governance`, `infra/scripts` | — | Backup produced | M |
| T-P11-13 | Restore verification job | `governance` | 12 | M14-AC-06 | M |
| T-P11-14 | Full health dashboard | `apps/web` | P2-55 | E2E | S |
| T-P11-15 | Security settings (MFA enforcement, token policy, admin IP allowlist) | `governance` | — | Tests | S |
| T-P11-16 | Personal data export/deletion | `governance` | — | Tests | M |
| T-P11-17 | RLS defence in depth (policies + session settings + BYPASSRLS system role) | `packages/db` | — | Isolation suite at DB layer | L |
| T-P11-18 | Performance test suite & tuning (NFR-PERF) | `tests/perf` | — | Thresholds met | M |
| T-P11-19 | Security suites: ZAP baseline, SSRF, uploads, prompt-injection evals | `tests/security` | — | Green / triaged | M |
| T-P11-20 | Pilot readiness checklist run + `v0.9-pilot` tag | owner | all | [27 §3](27-pilot-validation-plan.md) green | S |

## P12 — Personal pilot
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P12-01 | Select pilot projects (2–3) & document baseline context | owner | P11 | Pilot charter | S |
| T-P12-02 | Baseline measurement week (manual-only timings) | owner | 01 | Baseline sheet | M |
| T-P12-03 | Configure integrations (GitHub, Azure Boards, Claude, n8n) | owner | 01 | Health green | S |
| T-P12-04 | Requirements ingestion & approval for pilot projects | owner | 03 | Coverage baseline | M |
| T-P12-05 | Test design (AI-assisted) & manual cycles | owner | 04 | Metrics captured | L |
| T-P12-06 | Automation via codegen PRs + nightly regression | owner | 05 | Metrics captured | L |
| T-P12-07 | Weekly reviews (5–6) with KPI snapshot + issue log | owner | — | Weekly notes | M |
| T-P12-08 | False-positive / AI accuracy tracking | owner | — | Tracking sheet | S |
| T-P12-09 | Cost tracking (AI, infra time) | owner | — | Cost report | S |
| T-P12-10 | Pilot report + go/no-go | owner | 07 | Report | M |

## P13 — Enterprise readiness
| ID | Task | Area | Deps | Verify | Size |
|---|---|---|---|---|---|
| T-P13-01 | GitLab repository + issues adapters | `adapters-gitlab` | P12 | Contract suites (recorded) | L |
| T-P13-02 | GitLab webhook verification + dedupe header check (G2) | `adapters-gitlab` | 01 | Webhook suite | S |
| T-P13-03 | Azure Repos adapter | `adapters-azure-devops` | P12 | Contract | M |
| T-P13-04 | S3 storage adapter + localfs→S3 copy command | `adapters-storage-s3`, `tools/cli` | — | Storage contract + migration test | M |
| T-P13-05 | CI adapters (GitLab CI, GitHub Actions, Azure Pipelines) + CI-delegated backend + QualityOS reporter package | `adapters-ci-*`, `adapters-backend-ci` | — | CI contract + M08-AC-10 | L |
| T-P13-06 | Vault / Azure Key Vault SecretStore + migration command | `adapters-secrets-*` | — | Migration test | M |
| T-P13-07 | Azure DevOps Entra client-credentials (certificate) strategy | `adapters-azure-devops` | — | Recorded test | M |
| T-P13-08 | Server deployment: compose prod overlay, reverse proxy TLS, hardening guide | `infra/server` | — | Staging deploy | M |
| T-P13-09 | Runner agent mode / gVisor option evaluation | controller | — | ADR + prototype | L |
| T-P13-10 | OIDC adapter (Entra ID) | `adapters-identity-oidc` | — | Login tests | M |
| T-P13-11 | IdP group → role mapping | `identity` | 10 | Tests | S |
| T-P13-12 | Multi-team onboarding playbook + company project templates | docs, `projects` | — | Reviewed | M |
| T-P13-13 | Instance data export/import (project-level) tooling | `tools/cli` | — | Round-trip test | L |
| T-P13-14 | Legal/security review package (OD-01, OD-08, threat model) | docs | — | Sign-offs | M |
| T-P13-15 | OpenAI and Gemini adapters | `adapters-ai-*` | — | Contract (AI) | M |
| T-P13-16 | Company pilot setup + training material | docs | 08 | Training done | M |
| T-P13-17 | Live contract runs against company sandbox orgs | `contract-tests` | 01–07 | Report | S |
| T-P13-18 | Enterprise-scale performance test | `tests/perf` | 08 | NFR-SCAL targets | M |
| T-P13-19 | Core email Notifier adapter (n8n-independent contingency) | `adapters-notify-smtp` | — | Tests | S |
| T-P13-20 | Rollout readiness review ([28 §2](28-enterprise-rollout.md)) | owner + sponsors | all | Signed checklist | S |
