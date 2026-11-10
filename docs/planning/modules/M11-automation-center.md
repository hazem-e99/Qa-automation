# M11 — Automation Center

> Status: **Planned** · Phase: P7 · Owner: DevOps Engineer + Backend · Specs: [18](../18-n8n-orchestration.md), [19](../19-workflow-specifications.md), [ADR-0017](../adr/ADR-0017-orchestration-ownership.md)

## 1. Purpose & responsibilities
QA engineers configure and monitor automation **inside QualityOS**, so they never need to open n8n. This module owns:
- **automation rules**: event triggers, schedules, CI/deploy triggers
- event subscriptions
- workflow template versions
- dispatch and execution tracking
- orchestrator health
- the dead-letter view
- the fallback status

n8n carries out the workflows. QualityOS keeps the state ([ADR-0017](../adr/ADR-0017-orchestration-ownership.md)).

## 2. Roles
- `qa_lead`: manages rules for their projects.
- `platform_admin`: manages workflow templates, the orchestrator connection, and global subscriptions.
- `qa_engineer`: views rules and runs. Can trigger rules manually if permitted.

## 3. Features
| ID | Feature |
|---|---|
| M11-FR-01 | Rule catalog (templates) mapped to the brief's workflows: Requirements updated · Test plan generation requested · Test cases approved · Repository push · PR/MR created · Deployment completed · Scheduled smoke · Nightly regression · Test execution failed · Bug report prepared · Bug status changed · Fix detected · Bug retest requested · Weekly QA report |
| M11-FR-02 | Rule editor: template + parameters (e.g., schedule cron/RRULE + timezone, environment, suite/selection, notify channels, conditions like branch filter `main|release/*`), enabled flag, class (E/O-F/O shown read-only from template) |
| M11-FR-03 | Schedule ownership: schedules stored in QualityOS; n8n schedule workflows claim slots via Automation API; preview of next 5 slots |
| M11-FR-04 | Event subscriptions: which outbox event types dispatch to which workflow template version (auto-managed from rules) |
| M11-FR-05 | Automation runs view: each dispatch/firing → `automation_run` with steps reported by n8n callbacks, status, duration, linked entities (run created, notifications sent), errors |
| M11-FR-06 | Orchestrator health: status `healthy/degraded/down/unknown`, last probe, queue depth of pending dispatches, oldest pending age, fallback activity log |
| M11-FR-07 | Dead-letter view: dispatches/automation runs that exhausted retries; actions Retry, Discard with reason |
| M11-FR-08 | Workflow template versions: list of n8n workflow templates (from repo `infra/n8n/workflows`), version hash, deployed-at, drift status (exported JSON in n8n differs from repo → warning) |
| M11-FR-09 | Manual trigger ("Run now") for rules that allow it (creates firing with slot `manual:{uuid}`) |
| M11-FR-10 | Dry-run: evaluate rule conditions against a sample event and show resulting actions (no side effects) |
| M11-FR-11 | Notification channels config (in-app always; email/Teams/Slack via n8n) per rule |

## 4. User journeys
J6 (nightly regression rule), and the following setup journey: a QA lead enables the "Deployment completed → smoke" template for environment `staging`, picks the "Smoke" suite and the notification channel, runs a dry-run with a sample deployment event, saves the rule, and sees the first real firing in the Automation Runs view.

## 5. UI screens
- `S-AUT-01` Rules list: grouped by trigger type, with next fire time, last result, and class badge.
- `S-AUT-02` Rule editor: template parameters form, condition builder, schedule preview, dry-run panel.
- `S-AUT-03` Automation runs: a timeline with drill-down to steps.
- `S-AUT-04` Orchestrator status and dead letters (admin).
- `S-AUT-05` Workflow templates (admin): versions and drift.

## 6. Domain entities
`automation_rules`, `automation_rule_versions`, `automation_firings` (UNIQUE `rule_id, slot_key`), `event_subscriptions`, `workflow_templates`, `workflow_dispatches` (UNIQUE `event_id, subscription_id`), `automation_runs`, `automation_run_steps`, `orchestrator_health`, `idempotency_keys`, `outbox_events` ([10](../10-database-design.md)).

## 7. API endpoints
| Method | Path |
|---|---|
| GET | `/api/v1/automation/templates` |
| GET/POST | `/api/v1/projects/{key}/automation/rules` · GET/PATCH/DELETE `/{id}` · POST `/{id}:enable` · `:disable` · `:run-now` · `:dry-run` |
| GET | `/api/v1/projects/{key}/automation/rules/{id}/slots?next=5` |
| GET | `/api/v1/projects/{key}/automation/runs?ruleId&status` · `/{id}` |
| GET | `/api/v1/automation/orchestrator/status` · `/dead-letters` · POST `/dead-letters/{id}:retry` · `:discard` |
| **Automation API (n8n → core, service token, Idempotency-Key required)** | |
| GET | `/automation/v1/rules/{id}` (resolved params for workflow) |
| GET | `/automation/v1/schedules/due?window=2m` returns the slots that are due and not yet claimed, for the single `qos.scheduled-run` template ([18 §5](../18-n8n-orchestration.md)) |
| POST | `/automation/v1/ci/deployments` reports a deployment event coming from CI and matches it against deployment rules |
| POST | `/automation/v1/rules/{id}/fire` `{slotKey}` → `201 {firingId, action results}` or `200 {alreadyFired, firingId}` |
| POST | `/automation/v1/runs` · `/automation/v1/defects/{key}/retest` · `/automation/v1/ai/test-suggestions` · `/automation/v1/reports/weekly` |
| POST | `/automation/v1/automation-runs/{id}/steps` (progress callback) · `/automation/v1/automation-runs/{id}:complete` |
| POST | `/automation/v1/notifications/{id}:delivered` |
| GET | `/automation/v1/events/{eventId}` (fetch full event if dispatch payload was minimal) |

## 8. Business rules
- BR-M11-1: Firing a slot is **claim-based**: `INSERT … ON CONFLICT (rule_id, slot_key) DO NOTHING`. Only the claimant performs the actions. A second caller receives `alreadyFired` and the existing firing ID.
- BR-M11-2: The fallback scheduler (class E job, ticks every minute) fires an O-F rule slot only when **all** of these hold:
  - no firing exists for the slot
  - either `now ≥ slot + grace` (default grace 5 min) and the orchestrator status has been `down` or `degraded` for at least `grace`, or `now ≥ slot + 2 × grace` whatever the status (safety net for an orchestrator that reports healthy but does not fire)

  Fallback firings are tagged `fired_by=core_fallback`.
- BR-M11-3: Fallback executes only the closed action list (`run.create`, `retest.create`) plus an in-app notification. Class O rules never fall back. Their dispatches queue until `max_pending_age` (default 24 h), then go to the dead-letter queue.
- BR-M11-4: Slots missed during host downtime (laptop asleep) follow `catch_up_policy` per rule:
  - `latest_only` (default): fire only the most recent missed slot, if it is within `catch_up_window`.
  - `all`: fire every missed slot.
  - `none`: fire nothing.
- BR-M11-5: Rule edits create a new rule version. Firings record the rule version used.
- BR-M11-6: Every action performed through the Automation API carries `Idempotency-Key` = `firing:{id}:{action}` or `dispatch:{id}:{step}`.
- BR-M11-7: Disabling a rule stops new firings. In-flight automation runs complete.

## 9. Permissions
`automation.rule.read`, `automation.rule.manage`, `automation.rule.run_now`, `automation.admin` (templates, dead letters, orchestrator). Service token scopes: `automation:fire`, `automation:runs:create`, `automation:callbacks`, `automation:read`.

## 10. Provider dependencies
`WorkflowOrchestrator` port:
- **Required:** `orchestrator.dispatch@1`, `orchestrator.health@1`
- **Optional:** `orchestrator.templates.deploy@1` (CLI import), `orchestrator.executions.read@1` (n8n API, unverified on CE, see N5)

## 11. Events & workflow integration
This module is the integration point. Class E jobs:
- `outbox.dispatch`
- `automation.fallback-scheduler`
- `automation.runs.reaper` (time-outs)
- `orchestrator.health-probe`
- `dispatch.retry`

## 12. Security requirements
- The n8n service token is project-scoped or org-scoped, hashed at rest, rotatable, and limited to automation scopes. It cannot read requirements content beyond what the workflow needs, which is checked per endpoint.
- Outbound dispatches to n8n are signed with HMAC-SHA256 (`X-QOS-Signature`, timestamp, 5-min replay window). n8n workflows verify the signature in their first node, using the shared secret held as an n8n credential.
- Dispatch payloads are **minimal by default**: event ID, type, project key, and entity references. n8n fetches details through the Automation API under its token scopes, so confidential content does not sit in n8n's execution history.

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| n8n down | Health → `down`; O-F fallback after grace; O dispatches queued; banner in UI |
| n8n accepts dispatch but crashes before completing | `automation_run` stale (no callback before timeout) → reaper marks `timed_out` → retry dispatch (idempotent actions) up to N, then DLQ |
| n8n and fallback both fire | Impossible to double-act: firing claim unique; second gets `alreadyFired` |
| Clock skew between n8n and core | Slot keys computed by core from rule definition; n8n passes the scheduled slot it believes; core normalizes to nearest valid slot within ±2 min tolerance, else rejects with 409 |
| Template drift (edited in n8n UI) | Drift warning; deploy re-imports repo version (with confirmation) |
| Callback for unknown/finished run | 404/409, logged; no state change |

## 14. Edge cases
- DST changes: schedules are evaluated in the rule's timezone with RRULE semantics, and slot keys are UTC instants.
- Several projects share one n8n: templates are parameterized by rule ID, so there is one workflow per template, not per project.
- An n8n restart loses its in-memory executions, which recovers through the reaper and retry.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M11-AC-01 | Two concurrent `fire` calls for the same rule and slot produce exactly one firing and one test run. The second returns `alreadyFired`. |
| M11-AC-02 | With n8n stopped, the nightly regression rule (O-F) still creates its test run within grace + 1 min, tagged `core_fallback`, and an in-app notification is created. |
| M11-AC-03 | With n8n stopped, a Class O notification rule does not fall back. Its dispatch is queued and delivered after n8n restarts. |
| M11-AC-04 | Restarting n8n mid-workflow leads to a timed-out automation run that is retried, with no duplicate side effects (verified by counting created runs and notifications). |
| M11-AC-05 | A laptop "sleep" simulation (core stopped across 3 slots) with `latest_only` produces exactly one catch-up firing on resume. |
| M11-AC-06 | A dispatch with an invalid HMAC is rejected by the n8n template's verification node (workflow template test). |
| M11-AC-07 | The rule dry-run shows actions without creating any run, notification, or firing record. |
| M11-AC-08 | The workflow template drift detector flags a template modified in n8n's UI. |

## 16. Implementation tasks
- T-P7-01 outbox dispatcher + subscriptions
- T-P7-02 workflow_dispatches + retries + DLQ
- T-P7-03 Automation API (auth scopes, idempotency middleware)
- T-P7-04 automation rules + versions + templates registry
- T-P7-05 firing claim endpoint + slot computation (RRULE, tz)
- T-P7-06 fallback scheduler job
- T-P7-07 automation runs + callbacks + reaper
- T-P7-08 orchestrator health probe
- T-P7-09 n8n Compose service + persistent volume + CLI import/export scripts
- T-P7-10 n8n workflow templates (14) as JSON with HMAC verify node
- T-P7-11 rule editor UI + dry-run
- T-P7-12 automation runs UI
- T-P7-13 orchestrator status + DLQ UI
- T-P7-14 template drift detection
- T-P7-15 catch-up policy
- T-P7-16 notification delivery via n8n (email/Teams/Slack) + in-app
- T-P7-17 resilience test suite (n8n kill, core kill, sleep simulation)
- T-P7-18 workflow template contract tests (n8n in CI container)

## 17. Testing requirements
- Concurrency tests for firing claims.
- Chaos and resilience tests ([24 §10](../24-testing-strategy.md)).
- n8n templates tested in a containerized n8n in nightly CI: import, then trigger with signed and unsigned payloads, then assert the callbacks.

## 18. Dependencies & technical risks
Depends on M08 (run creation), M10 (retest), outbox (P1/P7), and n8n (OD-01 for company use).

| Risk | Mitigation |
|---|---|
| Workflow sprawl inside n8n | Templates live in the repo, only template-based rules are allowed, and drift is detected |
