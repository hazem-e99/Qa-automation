# M14 — Security, Audit and Settings

> Status: **Planned** · Phases: P2 (audit log, secrets, approval policy engine base, AI budgets base), P5 (AI usage limits enforcement), P11 (retention, backup UI, health, hardening) · Owner: Security Architect + Platform Engineer · Architecture: [21](../21-security-architecture.md), [22](../22-observability-and-reliability.md)

## 1. Purpose & responsibilities
This module provides the platform governance services that every other module relies on:
- the **audit log**
- **secret management**
- the **Approval Policy Engine**
- **AI usage limits and cost monitoring**
- **data retention**
- **backup and recovery** controls
- **notification preferences**
- **system health monitoring**
- system and organization settings

## 2. Roles
| Role | Can manage |
|---|---|
| `platform_admin` | System settings, backups, health, retention |
| `org_admin` | Org policies, budgets, approval policy templates |
| `qa_lead` | Project approval policies and budgets, within org limits |
| All users | Their own notification preferences |

## 3. Features
| ID | Feature |
|---|---|
| M14-FR-01 | Audit log: append-only `audit_events` (actor type/id, action, target type/id, project, before/after summary (redacted), source, IP, user agent, correlation id, time); search/filter/export; per-project and org views |
| M14-FR-02 | Audit integrity: hash chain per day (each event stores hash of previous + content); daily digest record; verification command |
| M14-FR-03 | Secret management: `SecretStore` port; default adapter envelope encryption (AES-256-GCM data keys, wrapped by master key from `QOS_MASTER_KEY_FILE`); secret metadata (owner, purpose, created, rotated, expires); rotation workflow; adapters for Vault/Azure Key Vault later |
| M14-FR-04 | Approval Policy Engine: per project, policies keyed by action (`requirement.approve`, `testcase.approve`, `defect.external.create`, `defect.external.transition`, `visual.baseline.approve`, `codegen.pr.open`, `run.production`, `ai.budget.increase`) → rules: required roles, approver count, separation of duties (author ≠ approver), conditions (severity, origin=inferred, environment), auto-approve allowances (explicit, narrow) |
| M14-FR-05 | Approval requests: unified inbox ("My approvals"), approve/reject with comment, expiry, escalation (class O notification), full audit |
| M14-FR-06 | AI usage limits: monthly budget per project and org (USD), per-task caps, per-user daily cap optional; soft warning at 80%, hard stop at 100% (configurable to "require approval to exceed"); provider price table (configurable, labelled with date) |
| M14-FR-07 | Cost monitoring: AI ledger per call (tokens in/out, cached, cost, task, model, user, project), compute seconds per run, storage bytes per project; dashboards in M12 |
| M14-FR-08 | Data retention policies: per data class (artifacts: videos 30d, traces 30d, screenshots 90d; run results: indefinite; AI prompt/response bodies: 30d; inbox messages: 30d; audit: 3y default; soft-deleted projects: 30d) with legal-hold flag per project |
| M14-FR-09 | Backup & recovery: scheduled `pg_dump` (custom format) + storage snapshot + n8n workflow/credential export (encrypted) via class E job or host script; restore runbook; restore verification job (restores to scratch DB and runs integrity checks) |
| M14-FR-10 | Notification preferences: per user per event category: in-app (always), email, Teams/Slack (if configured); digest options |
| M14-FR-11 | System health: component status (api, worker, controller, parser, db, storage, n8n, queue depth, DLQ size, disk space, cert/token expiries), with history |
| M14-FR-12 | System settings: org name, default locale/timezone, password policy, session timeouts, allowed upload types/sizes, egress defaults, feature flags |
| M14-FR-13 | Data export & deletion for a user (personal data) — supports GDPR-style requests where applicable |
| M14-FR-14 | Security settings: MFA enforcement, IP allowlist for admin (optional), API token policy (max lifetime) |

## 4. User journeys
- **Approval flow:** an approval request appears in "My approvals" → the reviewer sees the evidence → approves → the action executes and is audited.
- **Budget hit:** a QA engineer generates suggestions → the budget hits 80% → the lead is warned → at 100% generation is blocked → the lead requests an increase → org_admin approves.
- **Backup restore drill** (P11): admin runs restore verify → report green.

## 5. UI screens
- `S-SEC-01` Audit log explorer
- `S-SEC-02` Approval policies editor (project)
- `S-SEC-03` My approvals inbox
- `S-SEC-04` AI usage and budgets
- `S-SEC-05` Retention policies
- `S-SEC-06` Backups and restore verification
- `S-SEC-07` System health
- `S-SEC-08` System settings
- `S-SET-01` Personal settings: profile, notifications, theme, locale

## 6. Domain entities
`audit_events` (partitioned monthly), `audit_daily_digests`, `secrets` (metadata + ciphertext for default adapter), `secret_versions`, `approval_policies`, `approval_requests`, `approval_decisions`, `ai_usage_ledger`, `ai_budgets`, `price_tables`, `retention_policies`, `legal_holds`, `backup_runs`, `restore_verifications`, `notification_preferences`, `notifications`, `system_settings`, `health_checks`.

## 7. API endpoints
| Method | Path |
|---|---|
| GET | `/api/v1/audit?projectKey&actor&action&target&from&to&cursor` · POST `/audit:export` |
| GET/PUT | `/api/v1/projects/{key}/approval-policies` |
| GET | `/api/v1/me/approvals?status` · POST `/approvals/{id}:approve` · `:reject` |
| GET/PUT | `/api/v1/ai/budgets` (org) · `/api/v1/projects/{key}/ai/budget` |
| GET | `/api/v1/ai/usage?projectKey&from&to&groupBy` |
| GET/PUT | `/api/v1/settings/retention` · POST `/projects/{key}:legal-hold` |
| GET | `/api/v1/system/health` · `/system/backups` · POST `/system/backups:run` · `/system/backups/{id}:verify-restore` |
| GET/PUT | `/api/v1/settings/system` · `/api/v1/me/notification-preferences` |
| GET | `/api/v1/me/notifications` · POST `:mark-read` |

## 8. Business rules
- BR-M14-1: The audit log is append-only. The application DB role has `INSERT` and `SELECT` only on `audit_events`. There is no `UPDATE` or `DELETE`, and only the retention purge job, running under a separate role, can remove records past their retention period.
- BR-M14-2: Every approval rule enforces **separation of duties** by default: the author of a draft cannot approve it. Single-person pilot override: the policy `allow_self_approval` is allowed **only** when the project has a single member with an approver role. Each such approval is flagged in the audit.
- BR-M14-3: Approval requests snapshot the target content hash, and the approval applies only to that hash. If the content changes, the approval is invalidated.
- BR-M14-4: An AI call is rejected before it is sent if the estimated maximum cost exceeds the remaining budget, unless `exceed_with_approval` is set and an approval exists.
- BR-M14-5: Secrets are never logged, never returned, never sent to AI, and never included in exports. Redaction filters run on logs, audit diffs, and error records.
- BR-M14-6: Retention never deletes data under legal hold. Deletion is logged as an aggregate audit event (count per class).
- BR-M14-7: Price tables carry an `effective_from` date and source note. Costs are computed with the table effective at call time.

## 9. Permissions
`audit.read` (project, org), `audit.export`, `approval.policy.manage`, `approval.decide` (role-based per policy), `ai.budget.manage`, `ai.usage.read`, `retention.manage`, `legal_hold.manage`, `backup.manage`, `system.settings`, `health.read`.

## 10. Provider dependencies
- `SecretStore` (`db_envelope` in the pilot, `vault` and `azure_key_vault` later)
- `Notifier`
- `ObjectStorage` (backup target)
- AI provider usage data (token counts from responses)

## 11. Events & workflow integration
**Emits:**
- `approval.requested`
- `approval.decided`
- `budget.threshold.reached`
- `budget.exhausted`
- `backup.completed`
- `backup.failed`
- `restore.verified`
- `health.degraded`
- `secret.rotated`
- `secret.expiring`

**Class E jobs:**
- `audit.digest`
- `retention.purge`
- `backup.run` (or a host cron script in the pilot)
- `restore.verify`
- `health.collect`
- `budgets.reset` (monthly)

**Class O:** escalation notifications, budget alerts, backup failure alerts. In-app notifications are always created by the core.

## 12. Security requirements
- The master key is stored outside the database and outside the repository: a file mounted as a Docker secret. Losing the key means losing the secrets, which is documented ([23 §7](../23-local-deployment.md)).
- Key rotation re-wraps data keys and needs no data re-encryption.
- The audit export is itself audited.
- Backup files are encrypted (age/GPG with the admin's public key) before they leave the host.

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| Backup fails | Health → degraded + notification; retry next schedule; admin dashboard red |
| Restore verify fails | Severity high alert; backups marked unverified |
| Master key missing at startup | API refuses to start with explicit error (no plaintext fallback) |
| Approval approver leaves project | Pending requests reassigned to role pool; expired requests escalate |
| Price table outdated | Warning banner if `effective_from` older than 90 days |

## 14. Edge cases
- Concurrent approvals that reach the count simultaneously: the action executes exactly once, guarded by a state transition with an expected-state check.
- Changing a policy while approval requests are pending: the policy version at request time applies.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M14-AC-01 | Attempting UPDATE/DELETE on `audit_events` with the application DB role fails (DB permission test). |
| M14-AC-02 | The audit hash chain verification detects a tampered record in a test database. |
| M14-AC-03 | A draft author cannot approve their own draft under the default policy, and the self-approval override works only in single-approver projects and is flagged. |
| M14-AC-04 | Editing a draft after approval was requested invalidates the pending approval. |
| M14-AC-05 | An AI task whose estimated cost exceeds the remaining budget is rejected before any provider call (mock provider receives 0 requests). |
| M14-AC-06 | Restore verification restores the latest backup to a scratch DB and reports row counts and integrity checks. A corrupted backup is detected. |
| M14-AC-07 | Secrets never appear in logs during the full E2E suite (log scan for known secret values). |
| M14-AC-08 | Retention purges expired videos but not those under legal hold, and writes an aggregate audit event. |

## 16. Implementation tasks
- P2:
  - T-P2-50 audit events + interceptor + partitioning
  - T-P2-51 SecretStore port + envelope adapter + master key handling
  - T-P2-52 approval policy engine core + requests/decisions
  - T-P2-53 My approvals UI
  - T-P2-54 notifications (in-app) + preferences
  - T-P2-55 system health endpoint (basic)
  - T-P2-56 audit explorer UI
- P5:
  - T-P5-11 AI usage ledger + budgets + price tables
  - T-P5-12 budget enforcement in gateway
- P11:
  - T-P11-10 audit hash chain + digests
  - T-P11-11 retention policies + purge + legal hold
  - T-P11-12 backup job + encryption + UI
  - T-P11-13 restore verification
  - T-P11-14 health dashboard full
  - T-P11-15 security settings (MFA enforcement, token policy)
  - T-P11-16 personal data export/deletion
  - T-P11-17 RLS defence-in-depth (OD-10)

## 17. Testing requirements
- DB permission tests and approval engine property tests (concurrency, separation of duties).
- Budget enforcement tests.
- A backup/restore drill in CI nightly on a seeded DB.
- Log scanning for secrets across the E2E run.

## 18. Dependencies & technical risks
Foundation for all modules. Risk: the approval engine becomes too complex. Mitigation: a small fixed rule vocabulary, with no general rule language.
