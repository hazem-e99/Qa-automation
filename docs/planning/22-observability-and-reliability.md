# 22 — Observability and Reliability

> Status: **Planned** · Owner: Platform Engineer · Related: [17 §8](17-test-execution-engine.md), [18 §8](18-n8n-orchestration.md), NFR-REL/OBS in [06](06-non-functional-requirements.md)

## 1. Principles
The goal is production-grade reliability without over-engineering:
- **Correctness.** Atomic state changes, idempotent consumers, and reconciliation loops.
- **Visibility.** Correlation IDs everywhere, plus structured logs and a few meaningful metrics.
- **Recovery.** Every in-flight state has an owner and a timeout.

## 2. Structured logging
- **Library and format:** pino, JSON, one line per event.
- **Mandatory fields:** `ts`, `level`, `service` (api/worker/controller/web/parser), `env`, `correlationId`, `requestId` / `jobId`, `projectId` (if known), `actor`, `msg`, `event` (machine-readable code), `durationMs` (where relevant).
- **Correlation ID:**
  - It comes from the inbound `X-Correlation-Id` (validated), or is generated.
  - It is propagated into jobs (stored in pg-boss job data), outbox events, n8n dispatches (envelope), Automation API callbacks (header), sandbox env (`QOS_CORRELATION_ID`), and AI executions.
- **Redaction:** see [21 §10](21-security-architecture.md).
- **Levels:** `info` for business events, `warn` for recoverable issues, and `error` for failures that need attention. Debug output is off by default.
- **Storage (pilot):** Docker logs with rotation (`max-size 20m`, `max-file 5`). The optional `observability` compose profile adds Loki and Grafana. Enterprise: ship to central logging.

## 3. Tracing and metrics
- **Tracing:** OpenTelemetry SDK in api, worker, and controller. Auto-instrumentation covers HTTP, pg, and fetch. Manual spans cover job handling, provider calls, AI calls, and sandbox lifecycle.
  - Exporter: OTLP to an optional Jaeger or Tempo in the `observability` profile. It is a no-op otherwise.
  - Trace context is carried into jobs (`traceparent` in job data), which links async work.
- **Metrics** (OpenTelemetry metrics → Prometheus in the observability profile; key metrics are also stored in `health_checks` for the built-in health page):
  - `http_server_duration` (route, status)
  - `jobs_processed_total{queue,outcome}`, `job_duration{queue}`, `queue_depth{queue}`, `queue_oldest_age_seconds{queue}`, `dlq_size{queue}`
  - `runs_active`, `run_duration{project,trigger}`, `sandbox_cpu/mem peak`, `egress_denied_total`
  - `sync_lag_seconds{binding}`, `provider_errors_total{provider,kind}`, `provider_rate_limit_remaining`
  - `ai_tokens_total{task,model}`, `ai_cost_micros_total{project}`, `ai_validation_failures_total{task}`
  - `dispatch_pending{template}`, `orchestrator_status`, `fallback_firings_total`
  - `db_pool_in_use{service}`, `disk_free_bytes{volume}`

## 4. Delivery semantics and idempotency
**At-least-once is assumed everywhere** (pg-boss, outbox dispatch, webhooks, n8n retries). Consumer rules:
1. **Expected-state transitions:** `UPDATE … SET state = $new WHERE id = $id AND state = ANY($allowedFrom)`. If 0 rows change, the work was already done or is no longer valid, so the handler acks and logs `event=noop_transition`.
2. **Unique natural keys** for created records: firings, dispatches, run requests, result chunks, inbox messages, notifications, snapshots ([10 §4](10-database-design.md)).
3. **Idempotency keys** on API mutations. The record is stored in the same TX as the effect. The response is cached for 24 h, or 7 days for the automation scope.
4. **External side effects** (provider writes):
   - Record the intent (`idempotency_keys` row with status `in_progress`) before calling.
   - Use provider-side idempotency where available. Otherwise use a marker plus search to recover.
   - Mark `done` with the external ref.
5. **Job payloads carry IDs, not state.** Handlers load the current state and decide.

**Queue configuration principles:**
- `expireInSeconds` is set above the expected max duration.
- `heartbeatSeconds` is used for long jobs (runs, codegen, big syncs).
- `retryLimit` and backoff are set per queue ([17 §3](17-test-execution-engine.md)).
- Each queue family has a dead-letter queue, and DLQ size has an alert.

## 5. Timeouts
| Operation | Timeout | On timeout |
|---|---|---|
| HTTP request (api) | 30 s server; long ops become async operations | 504 + operation pattern |
| Provider API call | 20 s (connect 5 s) | retry per policy |
| AI call | per task (30–120 s) | retry once, fallback model, fail |
| Parser request | 120 s digital, 10 s/page OCR, max 30 min | kill parser worker, mark parse_failed |
| Sandbox test | policy `testTimeoutMs` | Playwright handles |
| Sandbox run | policy `runTimeoutMin` | SIGTERM → SIGKILL, errored(timeout) |
| n8n workflow (automation run) | template default 15 min (weekly report 30 min) | reaper → retry/DLQ |
| Approval request | 7 days | expire + escalate |
| Idempotency record `in_progress` | 10 min | considered failed; retry allowed with recovery search |

## 6. Circuit breakers (where justified)
- **Per provider connection:** opens after 5 consecutive `unavailable`/`timeout` errors within 60 s, with a half-open probe after 60 s. While open, sync and push jobs are deferred (`startAfter` = breaker reset), and the connection health shows `degraded`.
- **Per AI connection:** the same, and the UI disables AI actions with a message.
- **No breakers** on internal DB calls: if the DB is unavailable, the readiness check fails and processes stop claiming work.

## 7. Health checks and graceful shutdown
- **Liveness and readiness per process:**
  - `/healthz` (process alive)
  - `/readyz` (DB reachable, migrations at the expected version, storage writable, and for the controller: socket proxy reachable)
- **Compose:** `healthcheck` entries, plus `depends_on: condition: service_healthy`.
- **Graceful shutdown** (SIGTERM):
  - api stops accepting requests and drains in-flight ones (≤ 25 s).
  - worker stops fetching and lets running handlers finish or checkpoint (≤ 60 s); pg-boss `stop({graceful:true})`.
  - controller stops claiming new runs. It does **not** kill running sandboxes; those are left to reconciliation on restart, unless the shutdown is with `--drain`, in which case it waits for them.
- **System health page** (S-SEC-07) aggregates component status, queue depths, DLQ sizes, sync lags, orchestrator status, disk, token and certificate expiry, and backup freshness.

## 8. Restart recovery and partial failures
| Component restarted | What recovers it |
|---|---|
| api | Stateless; idempotency keys protect retried client requests; SSE clients reconnect |
| worker | pg-boss redelivers expired/heartbeat-lost jobs; outbox dispatcher resumes; sync resumes from cursors |
| execution-controller | `runs.reconcile` on start: re-attach, collect, or mark interrupted → requeue/errored ([17 §8](17-test-execution-engine.md)) |
| parser | Worker retries `document.parse` (idempotent by snapshot id) |
| n8n | Reaper + idempotent re-dispatch; fallback for O-F ([18 §8](18-n8n-orchestration.md)) |
| Postgres | All services retry with backoff; readiness false meanwhile; no writes lost (committed TX durable) |
| Whole host (reboot/sleep) | All of the above + catch-up policies for schedules + polling catch-up from cursors |

**Partial failure examples:**
- **Run finished but artifact processing failed.** The run is finalized with an `artifacts_incomplete` flag. `artifacts.process` retries, then goes to the DLQ, and the UI shows which artifacts are missing.
- **Defect approved but the external push failed.** The internal defect is open and its sync is pending or failed. A retry is available, and there is never a duplicate thanks to the marker.
- **The AI part of failure analysis failed.** The deterministic classification is shown, with an "AI unavailable" note and a re-analyze action.

## 9. Alerting
| Alert | Condition | Channel |
|---|---|---|
| Backup failed / stale | last successful > 26 h | in-app admin + email (n8n) |
| Restore verification failed | any | in-app + email |
| DLQ growth | size > 0 for queues `dlq.execution`, `dlq.results`; > 10 others | in-app |
| Orchestrator down | > 10 min | in-app banner + email (if n8n down, email via core minimal notifier fallback if configured) |
| Provider auth failed | any | in-app admin + project lead |
| Credential expiring | 14 d / 3 d | in-app + email |
| Disk low | < 15% or < 10 GB | in-app + email |
| Sync lag | > 3 × interval | in-app |
| AI budget | 80% / 100% | in-app + email |
| Stuck runs | any run exceeding timeout + 5 min (should never happen; reaper failure) | in-app admin |

## 10. Backup and restore verification
- The procedure is in [10 §10](10-database-design.md), and the runbook in [23 §8](23-local-deployment.md).
- **Weekly automated `restore.verify`** checks:
  - row counts per table versus the source snapshot counts
  - FK integrity
  - the audit hash chain
  - a random sample of 20 artifacts: storage object exists and sha256 matches
  - the n8n export parses

  The result is recorded and alerts on failure.
- **Quarterly manual drill** (enterprise): restore to a separate host and run the E2E smoke suite against it.

## 11. Runbooks (to be written in P11 as `docs/runbooks/*`)
- Interrupted test runs after a crash.
- n8n restart, n8n data loss, and template re-import.
- DLQ triage and replay.
- Provider token expired or revoked: rotation.
- Disk full: emergency retention.
- Restore from backup.
- Master key rotation.
- Provider switch rollback.
