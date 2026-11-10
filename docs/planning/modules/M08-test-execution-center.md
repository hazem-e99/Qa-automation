# M08 — Test Execution Center

> Status: **Planned** · Phase: P6 (quality gates P8) · Owner: QA Automation Architect + Platform Engineer · Engine spec: [17](../17-test-execution-engine.md), [ADR-0010](../adr/ADR-0010-sandboxed-execution.md), [ADR-0018](../adr/ADR-0018-test-engine-vs-execution-backend.md)

## 1. Purpose & responsibilities
This module requests, executes, observes, and records automated test runs, collects their evidence, and evaluates quality gates. It owns:
- run requests and selection (smoke, regression, targeted, impacted)
- execution policies
- the execution controller and sandboxes
- result ingestion (from local and CI backends)
- artifacts
- flaky detection
- the run viewer
- quality gate evaluation

## 2. Roles
| Role | Permission |
|---|---|
| `qa_engineer` | Trigger runs on non-production environments |
| `qa_lead` | Manage policies and gates |
| `developer` | Trigger targeted runs (policy-dependent) and view everything |
| `viewer` | Read only |
| Service tokens (n8n, CI) | Trigger runs through the Automation API |

## 3. Features
| ID | Feature |
|---|---|
| M08-FR-01 | Trigger types: `manual`, `schedule` (automation rule), `ci` (CI/deployment event), `pr` (pull/merge request), `retest` (defect verification), `api` |
| M08-FR-02 | Selection modes: suite, tag query, explicit test cases, **smoke** (tag `@smoke`), **regression** (suite flagged regression), **impacted** (change-impact selection, [19 WF-B](../19-workflow-specifications.md)), **failed-last-run** |
| M08-FR-03 | Run configuration: environment, build/version label, commit/ref of test repo (default branch HEAD by default), browsers (chromium/firefox/webkit), viewport/locale/theme matrix, shards, retries, timeout, backend (local Docker / CI) |
| M08-FR-04 | Execution policy enforcement per project ([17 §5](../17-test-execution-engine.md)) — max parallel runs, allowed environments per trigger, retries, timeouts, fork-PR deny |
| M08-FR-05 | Queueing with priority (`retest` > `pr` > `manual` > `ci` > `schedule`) and per-project concurrency; position visible |
| M08-FR-06 | Live run view: per-shard status, streaming logs (sanitized), progressive results as JUnit/JSON chunks arrive |
| M08-FR-07 | Cancellation: user/system cancel → graceful stop → partial results retained |
| M08-FR-08 | Retries: per-test retry attempts recorded separately; final status derivation: pass on first attempt = `passed`; fail then pass = `flaky` (counted as passed for gates only if policy `flaky_counts_as_pass`) ; all fail = `failed` |
| M08-FR-09 | Artifacts: screenshots, videos, Playwright traces, console logs, network HAR (optional, redacted), JUnit XML, JSON report — stored with retention class |
| M08-FR-10 | Run viewer: summary, results table (filter by status/classification/tag/requirement), test detail with attempts, embedded **trace viewer** (Playwright trace viewer served as static assets against our artifact URL), screenshots/video, error + stack, linked requirement/test case/defects |
| M08-FR-11 | Network failure evidence: failed requests (status ≥ 400, timeouts) extracted from trace/HAR into a "Network issues" panel |
| M08-FR-12 | Flaky detection: per test, rolling window flakiness score ([29](../29-business-case-and-kpis.md) KPI-08) → `flaky` label; quarantine option (policy) excludes from gate but still runs and reports |
| M08-FR-13 | Quality gates: rule sets (pass rate thresholds per selection, max new failures by classification/severity, required smoke 100%, coverage threshold) evaluated at run finalization → `pass/warn/fail` + reasons; optional report back to CI provider (`ci.status.report`) |
| M08-FR-14 | Run comparison: diff two runs (new failures, fixed, still failing, flaky) |
| M08-FR-15 | Execution history and trends per test (duration, status sparkline) |
| M08-FR-16 | CI-delegated backend: trigger pipeline with parameters (`ci.pipeline.trigger`) or ingest results pushed by CI via Automation API (`POST /automation/v1/runs/{id}/results`) |
| M08-FR-17 | Run reproducibility record: immutable run manifest (engine version, image digest, test repo commit, env base URL, config, seed) |

## 4. User journeys
J6 (nightly regression and triage), J7 (retest), J10 (gate result for a release).

## 5. UI screens
- `S-EXE-01` Runs list: status chips, trigger, environment, duration, pass/fail/flaky counts, gate result.
- `S-EXE-02` New run dialog: selection builder, matrix, policy hints ("Production not allowed for manual trigger").
- `S-EXE-03` Live run view.
- `S-EXE-04` Run viewer and failure analysis. Tabs: Summary, Results, Failures (grouped by AI cluster, in M10), Network, Artifacts, Manifest, Gate.
- `S-EXE-05` Test result detail: attempts timeline, trace viewer, media, error, links.
- `S-EXE-06` Execution policies and quality gates editor (in project settings).
- `S-EXE-07` Flaky tests board.

## 6. Domain entities
`test_runs` (kind `automated`), `run_requests`, `run_manifests`, `run_shards`, `test_executions`, `execution_attempts`, `test_results`, `artifacts`, `execution_policies` (project_settings section), `quality_gates`, `gate_evaluations`, `flaky_scores`, `automation_bindings` (from M07) — [10](../10-database-design.md).

## 7. API endpoints
| Method | Path |
|---|---|
| POST | `/api/v1/projects/{key}/runs` (selection, env, config; Idempotency-Key) → run (queued) |
| GET | `/api/v1/projects/{key}/runs?status&trigger&env&cursor` · `/{runKey}` · `/{runKey}/results` · `/{runKey}/manifest` |
| POST | `/api/v1/projects/{key}/runs/{runKey}:cancel` · `:rerun` (`scope=all|failed`) |
| GET | `/api/v1/projects/{key}/runs/{runKey}/stream` (SSE: status, logs, results) |
| GET | `/api/v1/projects/{key}/results/{resultId}` · `/attempts/{n}/artifacts` |
| GET | `/api/v1/projects/{key}/runs/compare?a&b` |
| GET/PUT | `/api/v1/projects/{key}/quality-gates` · GET `/runs/{runKey}/gate` |
| GET | `/api/v1/projects/{key}/flaky-tests` · POST `/flaky-tests/{bindingId}:quarantine` |
| POST | `/automation/v1/runs` (service token; Idempotency-Key required) |
| POST | `/automation/v1/runs/{id}/results` (CI-delegated ingestion; JUnit/JSON + artifact manifest) |
| POST | `/internal/v1/sandbox/runs/{id}/artifacts` (per-run upload token only; internal network) |

## 8. Business rules
- BR-M08-1: A run becomes **immutable** when finalized (`passed|failed|errored|cancelled`). Later reclassification of failures, defect links, and comments are *annotations* stored separately. They never change results.
- BR-M08-2: Every attempt is stored. A retry never overwrites a previous attempt.
- BR-M08-3: Only test cases with active bindings resolved at the run's test-repo commit are executed. Unbound selected cases are reported as `not_run (no_binding)`.
- BR-M08-4: Environment must be allowed for the trigger type by policy. `is_production` environments are only allowed for `smoke_readonly` runs that have explicit approval (BR-M02-5).
- BR-M08-5: Runs triggered from PRs of forked repositories are denied by default (untrusted code + secrets).
- BR-M08-6: Run idempotency: `(project, idempotency_key)` unique → same run returned. Automation firings carry `firing_id` as idempotency key.
- BR-M08-7: Gate evaluation uses only data available at finalization. It is re-evaluated only by explicit "re-evaluate" (audited), e.g., after quarantine change.
- BR-M08-8: A run interrupted by controller/host failure is marked `interrupted` then either re-queued (attempts < policy max, default 1) or finalized `errored` with reason ([17 §8](../17-test-execution-engine.md)).

## 9. Permissions
`run.trigger` (scoped by env policy), `run.trigger.production` (separate), `run.cancel`, `run.read`, `artifact.read`, `gate.manage`, `policy.execution.manage`, `flaky.quarantine`.

## 10. Provider dependencies
`TestEngine` (`engine.playwright@1`: discover, run spec, parse results, trace artifacts, visual compare); `ExecutionBackend` (`backend.local_docker@1` or `backend.ci@1`); `RepositoryProvider` (`repo.read`, `repo.archive.read` or clone token issuance); `CIProvider` (optional: `ci.pipeline.trigger`, `ci.status.report`, `ci.artifacts.read`); `ObjectStorage`.

## 11. Events & workflow integration
Emits `run.requested`, `run.started`, `run.shard.completed`, `run.finalized`, `run.interrupted`, `test.failed` (per failed final result), `gate.evaluated`, `flaky.detected`. Class E: `execution.run.requested` (controller), `results.ingest`, `artifacts.process`, `flaky.recompute`, `gate.evaluate`, `runs.reconcile` (on controller start + every 2 min). Class O-F: scheduled/CI/deploy-triggered run creation (n8n primary, fallback core). Class O: run-finished notifications, gate failure alerts.

## 12. Security requirements
Sandboxed execution per [ADR-0010](../adr/ADR-0010-sandboxed-execution.md); per-run tokens (archive download: read-only for this run's commit, ≤ run timeout + 10 min; upload: upload-only to that run). Sandboxes never hold provider credentials; logs sanitized (secret patterns + env secret values masked before storage); artifacts private, served via signed URLs (≤ 15 min); HAR capture off by default and redacted (cookies/authorization headers stripped) when on; trace viewer served from same origin with strict CSP; environment credentials injected as files in tmpfs, never logged.

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| Image pull fails | Retry ×3; then run `errored (infrastructure)`; health alert |
| Container OOM / timeout | Attempt `errored` with reason `oom`/`timeout`; artifacts collected so far uploaded; classification `infrastructure` suggested |
| Controller crash mid-run | On restart, reconcile by container label: running containers re-attached (log stream resumed) or, if gone, run `interrupted` → policy |
| Results upload partial | Ingestion is idempotent per (run, shard, chunk seq); missing chunks → shard `incomplete` → `errored` after grace |
| Env unreachable at start | Pre-flight check (HTTP to base URL via egress proxy) fails → run `errored (environment)` before spending sandbox time |
| Disk pressure on host | Controller refuses new runs below free-space threshold (default 10 GB); artifact retention job prioritized |

## 14. Edge cases
Selection resolves to 0 tests → run not created, user informed. Same test bound to multiple cases → executed once, result fanned out to all cases. Clock skew between sandbox and host → durations measured by controller. Very large test suites (>2,000 tests) → sharding mandatory by policy.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M08-AC-01 | A manual run of the demo smoke suite executes in a sandbox container running as non-root with read-only rootfs, and produces results, screenshots, and traces viewable in the run viewer. |
| M08-AC-02 | A test failing on attempt 1 and passing on attempt 2 is reported `flaky`, both attempts visible, and counted per policy in the gate. |
| M08-AC-03 | Killing the execution-controller process mid-run results, after restart, in either resumed observation or `interrupted` → re-queued run, never a run stuck in `running`. |
| M08-AC-04 | Submitting the same run request twice with the same Idempotency-Key creates exactly one run. |
| M08-AC-05 | A sandboxed test attempting to reach a host not in the environment allowlist fails with a network error logged as `egress_denied`. |
| M08-AC-06 | A sandboxed test cannot read host files or reach the Docker socket or the QualityOS DB (security test suite). |
| M08-AC-07 | Cancelling a running run stops containers within 30 s and finalizes as `cancelled` with partial results retained. |
| M08-AC-08 | A finalized run's results cannot be modified via any API; reclassification creates annotations only. |
| M08-AC-09 | Quality gate "smoke 100% and 0 new product defects ≥ high" evaluates correctly for pass and fail fixtures and its reasons list matches. |
| M08-AC-10 | Results posted by a CI-delegated backend through the Automation API produce the same canonical result model as local runs (contract test). |

## 16. Implementation tasks
T-P6-01 (run/execution/attempt/result model + state machine), T-P6-02 (run request API + idempotency + selection resolver), T-P6-03 (execution policy model + enforcement), T-P6-04 (Docker socket proxy + sandbox network + egress proxy compose services), T-P6-05 (execution-controller process: consume, launch, monitor, reconcile), T-P6-06 (sandbox image resolver by Playwright version), T-P6-07 (per-run tokens: clone/upload), T-P6-08 (in-container entrypoint: clone, install, run, upload), T-P6-09 (Playwright engine adapter: run spec, reporters config, result parser JUnit/JSON), T-P6-10 (artifact ingestion + storage + signed URLs), T-P6-11 (live stream SSE), T-P6-12 (run viewer UI + trace viewer embedding), T-P6-13 (cancellation), T-P6-14 (binding discovery by tag), T-P6-15 (flaky detection + board), T-P6-16 (run comparison), T-P6-17 (log sanitization), T-P6-18 (pre-flight environment check), T-P6-19 (sandbox security test suite), T-P6-20 (CI-delegated ingestion endpoint), T-P6-21 (disk/resource guards), T-P6-22 (runs list/new run UI). P8: T-P8-15 (quality gates + evaluation + CI status report).

## 17. Testing requirements
Engine adapter contract tests with recorded Playwright reports (pass/fail/flaky/timeout/skip). Controller integration tests with a fake container runtime + real Docker in nightly CI. Sandbox escape test suite (host file read, socket access, metadata IP, DB host, privilege escalation attempts). Resilience tests: kill controller/worker during runs ([24 §10](../24-testing-strategy.md)).

## 18. Dependencies & technical risks
Depends on M05/M07 bindings, M02 environments/policies, M03 repo adapter, storage. Risks: Docker Desktop on Windows differences (WSL2 networking for egress proxy) — spike T-P0-04; artifact volume growth — retention classes + disk guard.
