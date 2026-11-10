# 24 — Testing Strategy (testing QualityOS itself)

> Status: **Planned** · Owner: QA Automation Architect · Principle: **the bulk of the automated tests must run with no external credentials.**

## 1. Test pyramid and gates
| Level | Scope | Tools | Runs | Gate |
|---|---|---|---|---|
| Unit | Domain entities, value objects, policies, state machines, KPI formulas, validators, guards | Vitest | Every commit (PR) | Required |
| Integration | Use cases with real Postgres (Testcontainers), pg-boss, outbox/inbox, repositories, RLS | Vitest + Testcontainers | PR | Required |
| Contract (ports) | Every adapter against shared family suites (mock + recorded) | Vitest shared suites | PR | Required |
| Contract (APIs) | OpenAPI schema conformance; Automation API contract; event schemas; AI output schemas | Zod + OpenAPI diff | PR | Required |
| Workflow | n8n templates in containerized n8n: signature verify, idempotency headers, callbacks | Testcontainers (n8n) | Nightly + on template change | Required for template changes |
| End-to-end (UI) | Core journeys in demo mode (J1–J10 subsets) | Playwright (testing QualityOS's own UI) | PR (smoke subset), nightly (full) | Smoke required |
| AI evaluation | Task eval sets with recorded fixtures (deterministic), live optional | Custom eval runner | PR on prompt/model change; nightly live (optional) | Score ≥ baseline |
| Security | SAST, deps, images, secrets, authz matrix, sandbox escape, SSRF, upload fuzz, ZAP baseline, prompt-injection evals | Semgrep, OSV, Trivy, Gitleaks, custom suites, ZAP | PR (static), nightly (dynamic) | Critical = block |
| Performance | API latency, dashboard at scale, queue throughput, parser benchmarks | k6, autocannon, custom | Weekly + before release | Thresholds in [06](06-non-functional-requirements.md) |
| Accessibility | axe-core in E2E; keyboard-only flows; contrast token test | Playwright + axe | PR (core screens) | Serious/critical = block |
| Visual (QualityOS UI) | Components (Storybook) and core screens, light/dark, LTR/RTL | Playwright screenshots | PR (components), nightly (screens) | Reviewed diffs |
| Resilience | Kill/restart processes, n8n outage, DB restart, sleep simulation, disk pressure | Custom chaos scripts in Compose test env | Nightly | Required before pilot |
| Backup/restore | Backup → restore → verify integrity | Scripts | Nightly (seeded DB) | Required |
| Isolation | Multi-project data access matrix | Integration suite | PR | Required |

## 2. Coverage targets
- Domain at least 90% line coverage, application services at least 80%, and adapters covered by contract suites (NFR-MAINT-02).
- Coverage numbers are tracked, but **behavioral completeness is measured by the acceptance-criteria matrix** ([32](32-acceptance-criteria-matrix.md)). Every AC maps to at least one automated test, or to a documented manual check.

## 3. Test data and fixtures
| Fixture | Content | Used by |
|---|---|---|
| `fixtures/demo-app` | Small web app (login, catalog, cart, checkout, profile; EN/AR; RTL) with **toggleable seeded bugs** (via env flags), flaky behaviors (random delay toggles), and visual change toggles | Execution, codegen, visual, failure-classification evals, E2E |
| `fixtures/documents` | 30-file corpus EN/AR: DOCX, digital PDF, scanned PDF, XLSX/CSV, malformed/encrypted/zip-bomb samples; gold annotations | Parser contract, extraction evals |
| `fixtures/provider-recordings` | Scrubbed HTTP recordings per adapter (GitHub, Azure DevOps, GitLab, CI, AI) including error responses and pagination | Recorded contract tests |
| `fixtures/failures` | 150 labelled failure records (product/test/env/infra/flaky/data) with traces/logs/screenshots from demo-app runs | `failures.classify` evals |
| `fixtures/requirements-evals` | Requirements + expert test suites; conflict pairs; gap lists | AI evals |
| Seeds | `seed:demo`, `seed:perf` (50 projects, 1M results, 50k test cases) | Demo, perf |
- **Recordings** are made only from throwaway accounts with synthetic data. A scrubber removes tokens, emails, and IDs, then Gitleaks runs on the recordings directory.
- **Factories:** typed builders for every aggregate (`aRequirement().approved().withAC(3)`).

## 4. Mock-first principle
- Every port has a mock adapter with capability toggles and fault injection ([11 §8](11-provider-architecture.md)).
- The mock AI provider returns fixture responses keyed by `(taskId, inputHash)`, falling back to template-generated valid outputs. This keeps E2E deterministic.
- **Live tests** with real GitHub, Azure DevOps, Claude, or n8n are optional and gated by env vars. They run nightly when credentials are present, and their failures open a maintenance issue. They never block PRs.

## 5. Provider compatibility testing
- **Shared suites:** one per family in `packages/contract-tests/<family>`. Each suite is parameterized by `{adapterFactory, mode: mock|recorded|live, capabilities}`.
- **Capability-aware:** tests for capabilities that are absent are **skipped with a reason** that the manifest generates. A CI report lists pass, skip, and fail per adapter and per capability, and that report generates the [33](33-provider-compatibility-matrix.md) matrix.
- **The same suite must pass for GitHub and GitLab adapters**, for example. Differences (labels vs native severity, open/closed vs workflow states) are expressed through the manifest and mappings, never by forking the tests.
- **Mixed-provider E2E:** "Repo=GitHub(mock), Requirements=PDF, Issues=Azure Boards(mock)" and "Repo=GitLab(mock), Requirements=Azure(mock), Issues=Internal" run in parallel in one instance. The test asserts independence and correct routing.
- **Provider switch E2E:** WF-F, from GitHub mock to GitLab mock. The test asserts historical refs render, new work routes to the new provider, and the audit trail is intact.

## 6. Workflow tests (n8n)
- The nightly job starts a containerized n8n with the pinned image, imports templates from the repo, and points the QualityOS Automation API at a test instance.
- For each template:
  - A signed dispatch is accepted, the expected Automation API calls are made with idempotency keys, and the callbacks complete the automation run.
  - An unsigned or stale dispatch is rejected.
  - A replayed dispatch produces no duplicate side effects.
- Fallback tests:
  - Stop n8n, then confirm that O-F firings fall back and O dispatches queue.
  - Restart n8n, then confirm that the queued dispatches deliver and every `fire` call returns `alreadyFired`.

## 7. AI evaluation tests
- An eval runner per task ([15 §10](15-ai-agent-architecture.md)). Deterministic scoring where possible (schema validity, grounding, AC coverage, classification accuracy). Rubric scoring by humans for drafts, recorded in the dataset.
- **Recorded mode:** replays stored model outputs. It tests the validators, parsing, and scoring code deterministically on every PR.
- **Live mode:** calls the configured provider with budget caps. It runs on prompt or model changes, and weekly during the pilot.
- **Regression gate:** a new prompt version must score at least as well as the current one on its eval set.

## 8. Security tests
| Suite | Examples |
|---|---|
| Authorization matrix | Generated from M13 matrix: each role × permission → allow/deny assertions; foreign project → 404 |
| Isolation | Two projects with identical keys in data; cross-access attempts via every list/detail endpoint; dashboard totals |
| Sandbox escape | From inside a test: read `/etc/hostname` of host? (expect container's), access `host.docker.internal`, `169.254.169.254`, `postgres:5432`, `api:3000` (non-sandbox listener), docker socket paths, write to rootfs, `setuid` binaries, fork bomb (pids limit), memory bomb (OOM recorded) |
| Egress | Requests to allowlisted host succeed; non-allowlisted denied and logged |
| SSRF | Connection base URL/environment URL/reset hook pointing to loopback, metadata, internal names, DNS rebinding simulation |
| Uploads | Polyglot PDF/JS, oversized, encrypted, zip bomb DOCX, EXIF image, SVG with script |
| Webhooks | Invalid HMAC, wrong token, replay, oversized body, unknown connection timing |
| Secrets | Log scan across full E2E for known secret values and token patterns; API response scan |
| Prompt injection | Documents/issues/DOM containing "ignore previous instructions…" style payloads → outputs must not contain injected actions/URLs; validators flag anomalies |
| DAST | OWASP ZAP baseline scan against local instance |

## 9. Multi-project isolation tests
- A seed with projects A and B, and users holding different roles in each.
- Every API route, enumerated from the router, is called against B's resources with an A-only user. The expected result is 404 or 403 according to the rules, and never a 200 with data.
- With RLS enabled (P11), the same suite runs at the DB layer with a raw query harness.

## 10. Resilience tests
| Scenario | Expected |
|---|---|
| Kill controller mid-run | Reconcile → resumed or interrupted→requeued; no stuck runs (M08-AC-03) |
| Kill worker during results ingestion | Redelivery; no duplicate results (chunk keys) |
| Stop n8n during nightly slot | Fallback fires once; n8n later gets alreadyFired (M11-AC-01/02) |
| Restart n8n mid-workflow | Timed-out automation run retried; no duplicate effects (M11-AC-04) |
| Postgres restart | Services recover; no lost committed data; jobs resume |
| Simulated sleep (stop all for 3 slots) | Catch-up policy respected (M11-AC-05) |
| Provider returns 429 storm | Backoff; sync resumes from cursor; no data loss |
| Disk pressure | Controller stops claiming; alert; retention prioritized |
| AI provider outage | Circuit opens; manual paths work; queued AI tasks resume |

## 11. Performance tests
- **API:** k6 scenarios for typical QA usage (list/detail/step updates) against `seed:perf`, checked against the NFR-PERF thresholds.
- **Dashboard:** summary and trends with 50 projects and 1M results (NFR-PERF-02).
- **Queue:** 5k jobs burst, measuring drain time and DB load.
- **Parser:** a benchmark on the corpus (NFR-PERF-05).
- **Execution:** sandbox start overhead with a warm cache (NFR-PERF-04).

## 12. Testing in each phase
Every phase in [25](25-implementation-roadmap.md) lists its required tests. The **Definition of Done** for any task includes:
- unit and integration tests for new logic
- contract tests when touching ports or adapters
- an E2E update when touching a journey
- no new critical security findings
- docs updated: API, ADR if needed, and the relevant planning document if a decision changed
