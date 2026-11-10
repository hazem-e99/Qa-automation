# 18 — n8n Orchestration

> Status: **Planned** · Owner: DevOps Engineer + Principal Architect · Decisions: [ADR-0008](adr/ADR-0008-n8n-orchestrator.md), [ADR-0017](adr/ADR-0017-orchestration-ownership.md) · Module: [M11](modules/M11-automation-center.md) · Facts: [36 §1](36-technical-validation.md)

## 1. Principles
1. **PostgreSQL (QualityOS) is the source of truth.** n8n stores no business data. Losing n8n's database loses only n8n's execution history.
2. **n8n is the only workflow engine.** The core contains a *job processor* for essential operations and a *closed-list fallback*. It has no second workflow designer or engine.
3. **Every n8n side effect on QualityOS goes through the Automation API.** That API is authenticated, scoped, idempotent, and audited.
4. **Workflows are code.** Templates are versioned in the repository and imported at deploy. Drift is detected.
5. **The core keeps working without n8n.** It degrades in clear, observable ways.

## 2. Responsibility split
| Operation | n8n | Backend (core) | AI services (gateway) | CI runners / sandboxes |
|---|---|---|---|---|
| Domain rules, permissions, approvals | — | **Owner** | — | — |
| Persistent state (runs, defects, firings, automation runs) | — | **Owner** | — | — |
| Polling providers, inbox, sync | — | **Owner (E)** | — | — |
| Executing tests | — | Orchestrates (controller) | — | **Owner** (sandbox / CI job) |
| AI inference | — | Requests tasks | **Owner** | — (codegen via gateway proxy) |
| Schedule triggers for user rules | **Primary** (claims slots) | Fallback for O-F only | — | — |
| Reacting to events with configurable steps (wait for deploy, then smoke, then notify) | **Owner** | Exposes actions via Automation API | — | — |
| Notification fan-out (email/Teams/Slack) | **Owner** | In-app notifications (always) | — | — |
| Weekly report delivery | **Owner** (delivery) | Report generation (E) | Narrative task | — |
| Custom team recipes (e.g. post to a channel when a gate fails on release branch) | **Owner** | — | — | — |
| Calling external providers (GitHub, Azure) | **No** in core templates (teams may add, at own risk, outside QualityOS guarantees) | **Owner** | — | — |
| Workflow definitions | Runtime copy | **Source of truth = repo** | — | — |

## 3. Work classes
| Class | Examples | Behavior when n8n is down |
|---|---|---|
| **E (essential)** | outbox dispatch, inbox processing, `sync.poll`, run execution, result ingestion, finalize, gate evaluation, failure analysis, AI tasks, retention, backups, health, credential expiry, fallback scheduler tick | Unaffected |
| **O-F (orchestrated, fallback)** | scheduled smoke, nightly regression, deployment-completed → run, CI/PR-triggered run (when routed via n8n), bug retest on fix candidate | Core fires minimal action after grace if slot/event unclaimed |
| **O (orchestrated only)** | email/Teams/Slack notifications, weekly report delivery, approval escalations, custom recipes, "requirements updated → notify", "test cases approved → notify automation engineer" | Queued durably until n8n recovers; expire after `max_pending_age` → DLQ + in-app notice |

**Rule:** only these closed-list actions may fall back: `run.create` (for schedule, deploy, and CI rules) and `retest.create` (for fix detection). Adding to this list requires an ADR.

## 4. Event routing
```mermaid
sequenceDiagram
  participant UC as Use case (TX)
  participant DB as Postgres
  participant D as Dispatcher (worker, class E)
  participant N as n8n
  participant API as Automation API
  UC->>DB: state change + outbox_events(event_id) [same TX]
  D->>DB: SELECT … FROM outbox_events WHERE dispatched_at IS NULL FOR UPDATE SKIP LOCKED LIMIT 100
  D->>DB: for each matching event_subscription → INSERT workflow_dispatches ON CONFLICT DO NOTHING
  D->>DB: mark outbox dispatched_at (internal subscribers handled in same loop)
  loop each pending dispatch (orchestrator target)
    D->>N: POST /webhook/{templatePath} {eventId,type,projectKey,refs,ts} + X-QOS-Signature
    alt 2xx
      D->>DB: dispatch.status=accepted; create automation_run(dispatched, timeout_at)
    else error/timeout
      D->>DB: attempts++, next_attempt_at=backoff (1m,2m,5m,15m,1h…); after max → dead
    end
  end
  N->>API: GET /automation/v1/events/{eventId} (details under token scopes)
  N->>API: POST /automation/v1/automation-runs/{id}/steps (progress)
  N->>API: POST /automation/v1/... action (Idempotency-Key = dispatch:{id}:{step})
  N->>API: POST /automation/v1/automation-runs/{id}:complete
```

**Minimal payload principle:** the dispatch carries only IDs and types. n8n pulls details through scoped endpoints. This limits the confidential data held in n8n's execution history and keeps contracts stable.

**Event envelope** (dispatch body):
```json
{ "specVersion": "1.0", "eventId": "0193…", "type": "run.finalized", "occurredAt": "2026-11-09T02:14:03Z",
  "projectKey": "SHOP", "subject": {"type": "test_run", "id": "0193…", "key": "SHOP-RUN-88"},
  "automationRunId": "0193…", "correlationId": "c-…", "ruleId": "0193…?" }
```

## 5. Scheduling ownership and slot claims
- **Rules live in QualityOS** (`automation_rules`, versioned). Each rule has an RRULE plus timezone, a grace period (default 5 min), a `catch_up_policy`, and a class.
- **The n8n template "Scheduled run"** is a single workflow:
  1. A Schedule Trigger fires every minute.
  2. `GET /automation/v1/schedules/due?window=2m` returns `[{ruleId, slotKey}]` for slots due now that are not yet claimed.
  3. For each slot, the workflow calls `POST /automation/v1/rules/{id}/fire {slotKey}`.
  4. The workflow then runs any configured enrichment (notifications) for the actions created.

  So n8n doesn't need one workflow per rule, and rule edits in QualityOS take effect without touching n8n.
- **Claim semantics:** `INSERT INTO automation_firings(rule_id, slot_key, fired_by) … ON CONFLICT DO NOTHING RETURNING id`.
  - The insert and the action (e.g. creating the run with `Idempotency-Key = firing:{id}:run.create`) happen in one transaction.
  - On conflict, the response is `200 {alreadyFired: true, firingId}`.
- **Fallback scheduler** (class E, pg-boss cron every minute): for each enabled O-F rule, it computes slots in `[now - catch_up_window, now - grace]` that have no firing. It fires only if `orchestrator_health.status ∈ {down, degraded}` for ≥ grace, **or** if the slot is older than `2 × grace` regardless of health. The second case covers n8n reporting healthy while not executing.
  - It uses the same claim insert, with `fired_by = core_fallback`.
  - It creates an in-app notification "Fired by fallback (orchestrator unavailable)".
- **Sleep and offline catch-up:** `latest_only` (default) fires only the most recent missed slot within `catch_up_window` (default 12 h). Older missed slots are recorded as `skipped` firings, so they are never fired late.

## 6. Idempotency and duplicate prevention (summary)
| Path | Mechanism |
|---|---|
| Outbox → dispatch | `workflow_dispatches UNIQUE(event_id, subscription_id)` |
| n8n retries a step | `Idempotency-Key` stored in `idempotency_keys`. Same key + same body hash → cached response. Same key + different body → 422 |
| n8n and fallback both fire | `automation_firings UNIQUE(rule_id, slot_key)` |
| Duplicate run creation | `run_requests UNIQUE(project_id, idempotency_key)` with key = `firing:{id}:run.create` |
| Duplicate retest | Key `defect:{id}:fix:{fixRefId}:retest` |
| Duplicate notification | `notifications UNIQUE(user_id, dedupe_key)`. n8n external sends carry `dedupeKey`, and n8n templates check `/automation/v1/notifications/{id}` state before sending (best-effort; external channels are not transactional, and duplicates are possible after crashes, so they are documented as at-least-once) |

## 7. Execution state management
- `automation_runs` (core) has the states: `dispatched → running → completed | failed | timed_out | dead_lettered`.
- n8n calls `steps` to move a run to `running` and record its progress, then `:complete` with a success or failure summary.
- **Reaper (class E, every minute):**
  - A run in `dispatched` or `running` past `timeout_at` (template default 15 min) moves to `timed_out`.
  - If `retry_count < max` (default 2), the dispatch is re-sent with the same `eventId`. This is safe because every action is idempotent.
  - Otherwise the run moves to `dead_lettered` and appears in the Automation Center.
- **If `orchestrator.executions.read` is available** (n8n API on CE, unverified N5), the reaper can query the n8n execution status before re-dispatching. This avoids re-running workflows that are still progressing but slow.

## 8. Recovery scenarios
| Scenario | Effect | Recovery |
|---|---|---|
| **n8n restarts mid-workflow** | n8n execution lost (unless n8n's own recovery resumes it) | Reaper → timed_out → re-dispatch (idempotent actions) |
| **n8n down for hours** | Dispatches accumulate (`pending`); health `down` | O-F rules fire via fallback; O dispatches delivered on recovery in order of `occurred_at`; those older than `max_pending_age` dead-lettered |
| **QualityOS api/worker restart** | In-flight jobs | pg-boss redelivers expired jobs; dispatcher resumes from undispatched outbox; idempotency prevents doubles |
| **Postgres restart** | All processes retry connections | n8n calls to Automation API fail → n8n retry settings (per HTTP node: 3 retries, backoff) → then workflow error → reaper handles |
| **n8n data volume lost** | Templates and credentials gone | `scripts/n8n-import.sh` re-imports templates from repo; re-create 2 credentials from secrets (documented runbook); no business data lost |
| **Laptop asleep across schedules** | Missed slots | Catch-up policy on wake |
| **Clock jump (DST/NTP)** | Slot computation | Slots computed by core in rule timezone; keys are UTC instants; claim tolerance ±2 min |

## 9. Workflow templates (initial set)
| Template ID | Trigger | Class | Steps |
|---|---|---|---|
| `qos.scheduled-run` | Schedule (1 min) → due slots | O-F | fire slot → notify run started (optional) |
| `qos.deployment-completed` | Dispatch `ci.deployment.completed` (from CI adapter sync) or external webhook into n8n from CI (verified) → `POST /automation/v1/ci/deployments` | O-F | match rules → fire with slotKey `deploy:{deploymentId}` → notify |
| `qos.pr-opened` | Dispatch `repo.pr.opened` | O-F | fire PR rule (impacted selection) → comment link (via core action, which calls repo adapter `repo.pr.comment` subject to policy) |
| `qos.repo-push` | Dispatch `repo.push.detected` | O | change-impact preview notification; optional targeted run via rule |
| `qos.run-finished-notify` | Dispatch `run.finalized` | O | fetch summary → channel message (fail → highlight) |
| `qos.run-failed-triage` | Dispatch `gate.evaluated` (fail) | O | notify owners with triage link |
| `qos.requirements-updated` | Dispatch `requirement.impact.detected` | O | notify QA lead; optionally request `tests.suggest_updates` via Automation API (creates suggestions only) |
| `qos.test-plan-requested` | Dispatch `requirement.version.approved` (batch, debounced 10 min) | O | request AI test suggestions (operation) → notify when ready |
| `qos.testcases-approved` | Dispatch `testcase.version.approved` (batch) | O | notify automation engineers of new candidates |
| `qos.bug-prepared` | Dispatch `defect.draft.created` | O | notify approvers; escalation after 24 h |
| `qos.bug-status-changed` | Dispatch `defect.state.changed` | O | notify tester/assignee |
| `qos.fix-detected-retest` | Dispatch `defect.fix_candidate` | O-F | create retest via Automation API → notify |
| `qos.weekly-report` | Schedule weekly (rule) | O | `POST /automation/v1/reports/weekly` → wait for operation → deliver link |
| `qos.health` | GET webhook | — | returns 200 (health probe) |

Every template:
- starts with a **signature verification** Code node (HMAC-SHA256 over `timestamp + body`, rejecting anything older than 5 min)
- uses the `QualityOS API` credential
- passes `Idempotency-Key` headers on every POST
- reports steps and completion

## 10. Local deployment (Docker Compose excerpt; illustrative, not executed)
```yaml
# infra/compose/docker-compose.yml (profile: n8n)
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:<PINNED_TAG>   # pinned in T-P0-03
    profiles: ["n8n"]
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: postgres
      DB_POSTGRESDB_DATABASE: n8n
      DB_POSTGRESDB_USER: n8n
      DB_POSTGRESDB_PASSWORD_FILE: /run/secrets/n8n_db_password
      N8N_ENCRYPTION_KEY_FILE: /run/secrets/n8n_encryption_key
      N8N_HOST: localhost
      N8N_PORT: 5678
      N8N_PROTOCOL: http
      GENERIC_TIMEZONE: ${QOS_TIMEZONE}
      N8N_DIAGNOSTICS_ENABLED: "false"
      N8N_PERSONALIZATION_ENABLED: "false"
      EXECUTIONS_DATA_PRUNE: "true"
      EXECUTIONS_DATA_MAX_AGE: "336"   # hours (14 days)
    volumes:
      - n8n_data:/home/node/.n8n
      - ../n8n/workflows:/workflows:ro
    ports: ["127.0.0.1:5678:5678"]   # editor reachable only from localhost
    networks: [qos-internal]
    secrets: [n8n_db_password, n8n_encryption_key]
    depends_on: { postgres: { condition: service_healthy } }
```
- **Environment variables** (`*_FILE` support, telemetry flags, execution pruning) must be **verified against the docs of the pinned n8n version** in T-P0-03 before they are relied on.
- On first start, the n8n owner account is created with a strong password stored in the owner's password manager. Enable n8n's MFA if the pinned version offers it on CE (check in T-P0-03).
- The editor binds to `127.0.0.1` only. Workflow webhooks are reached by the dispatcher over the internal network, so nothing in n8n is exposed to the internet.
- **External event intake:** providers never call n8n directly. They call QualityOS `/webhooks/*` (verified, inbox). n8n only ever receives dispatches from QualityOS. This keeps webhook verification in one place.

## 11. Workflow versioning and deployment
1. Templates live at `infra/n8n/workflows/qos.<name>.json` with fixed `id` values and a `versionTag` in the workflow meta.
2. `scripts/n8n-import.sh` runs `docker compose exec n8n n8n import:workflow --separate --input=/workflows` and then activates the workflows. Activation needs a CLI or API step that is verified in T-P0-03.
3. `scripts/n8n-export.sh` runs `export:workflow --backup --output=/tmp/export`, then `sanitize-workflows.ts`, which:
   - strips credential IDs and replaces them with names
   - removes instance-specific fields
   - sorts keys

   The script then copies the results into the repo.
4. A CI check validates each template JSON: it has a signature-verification first node, no inline secrets (Gitleaks), and `Idempotency-Key` headers on HTTP nodes that call `/automation/v1`.
5. QualityOS `workflow_templates` records the hash of each deployed template. The drift detector compares an export of the running n8n with the repo version (M11-FR-08).

## 12. Connectivity for external events in local mode
| Approach | Use | Pros | Cons | Decision |
|---|---|---|---|---|
| **Polling** | Always | Works offline/asleep, no exposure | Latency (minutes) | **Primary** |
| Cloudflare Tunnel (named tunnel, path-restricted) | Optional, low latency webhooks | HTTPS, no open ports, stable hostname | External dependency; must restrict to `/webhooks/*` | Optional |
| ngrok / Tailscale Funnel | Optional | Easy | Free tiers change; random URLs | Optional |
| smee.io | GitHub dev only | Simple | Public channel URL; third-party relays payloads | Not recommended for anything beyond throwaway tests |
| Port forwarding on router | — | — | Exposes host | **Rejected** |

Tunnel rules:
- The ingress listener (port 3001) serves only `/webhooks/{connectionId}/{pathSecret?}`, with signature or secret verification, a body limit, and rate limiting.
- The UI and API (port 3000) are never tunnelled.
- Azure DevOps requires HTTPS for Basic auth (A5), so a tunnel is the only way to receive Azure service hooks locally.

## 13. Replaceability
To replace n8n:
1. Implement the `WorkflowOrchestrator` adapter for the new engine (dispatch plus health).
2. Port the 14 templates to the new engine. Each must call the same Automation API endpoints with the same idempotency keys.
3. Run the template contract tests (M11-AC-*).
4. Switch the org orchestrator connection.

No domain change is needed. If the company declines n8n entirely (OD-01), the **Null adapter** keeps every class E and O-F behavior, and class O notifications fall back to in-app plus email sent by a minimal core notifier. That optional `Notifier` email adapter is listed as a contingency in [30](30-risks-and-mitigations.md) R-03.
