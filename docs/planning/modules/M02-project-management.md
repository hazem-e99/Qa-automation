# M02 — Project Management

> Status: **Planned** · Phase: P2 · Owner: Backend + Frontend · Related: [M03](M03-integration-hub.md), [M13](M13-team-permissions.md), [11](../11-provider-architecture.md)

## 1. Purpose & responsibilities
This module creates and configures **projects**, the unit of isolation. It owns:
- project identity
- environments
- **role bindings** (which connection plays which role for this project)
- project-level settings: testing rules, execution policy, AI configuration, quality targets, approval policies (stored here, enforced by M14), and templates

## 2. Roles
- Create a project: `org_admin` or `platform_admin`.
- Configure it: `qa_lead` (most settings), `org_admin` (bindings to org connections, archive or delete).
- Everyone else is read-only per their project role.

## 3. Features
| ID | Feature |
|---|---|
| M02-FR-01 | Project creation wizard (8 steps, resumable as a draft): basics (name, key, description, tags) → application repository binding → test repository mode and binding ([ADR-0009](../adr/ADR-0009-test-code-location.md)) → requirements sources (0..n) → issue tracker → CI provider (optional) → AI configuration → environments → members → review and health check |
| M02-FR-02 | Create from **template**: a predefined set of statuses, severities, test types, approval policies, and quality gates (e.g. "Web app – standard", "API service") |
| M02-FR-03 | Environments: name, base URL(s), allowed hosts (egress allowlist), auth strategy for tests (storage-state secret ref), data reset hook (optional URL), tags, `is_production` flag (production runs blocked unless policy allows read-only smoke) |
| M02-FR-04 | Role bindings: `repository`, `test_repository`, `requirements[]`, `issue_tracker`, `ci`, `ai`, `notifications`, `storage` (inherits org default), `orchestrator` (inherits org default). Each binding shows the required capabilities and whether the bound connection meets them |
| M02-FR-05 | Project testing rules: test case template fields, mandatory fields, naming conventions, required tags, default priorities |
| M02-FR-06 | Execution policy ([17 §5](../17-test-execution-engine.md)): max parallel runs, shards, timeouts, retry policy, browsers, allowed environments per trigger type, artifact retention, fork-PR policy |
| M02-FR-07 | AI configuration: provider connection, model per task class (fast/standard/deep), monthly budget, redaction rules, data-sharing consent flag, tasks enabled/disabled |
| M02-FR-08 | Quality targets and gates: requirement coverage target, flaky threshold, gate definitions (link to M08) |
| M02-FR-09 | Integration health panel: live status of every binding (last check, last sync, errors, token expiry) with "Re-test" |
| M02-FR-10 | Archive (read-only, hidden from defaults), restore, delete (only when archived, needs typed confirmation, soft-delete with 30-day purge, audit retained) |
| M02-FR-11 | Project overview page: summary, health, recent activity, quick actions |
| M02-FR-12 | Clone project configuration (no data) for a new project |

## 4. User journeys
J1 (setup), J9 (provider switch: binding change UI lives here, flow in [19 WF-F](../19-workflow-specifications.md)).

## 5. UI screens
- `S-PRJ-01` Project Overview
- `S-PRJ-02` Creation Wizard (stepper; each step validated; "Save draft")
- `S-PRJ-03` Settings (tabs: General, Environments, Integrations/Bindings, Testing rules, Execution, AI, Quality, Approvals, Notifications, Danger zone)
- `S-PRJ-04` Environment editor (drawer)
- `S-PRJ-05` Binding change dialog (capability diff: "GitLab supports 12/12 required capabilities; missing optional: `repo.checks.report`")

## 6. Domain entities
`projects`, `project_environments`, `project_bindings`, `project_settings` (typed JSONB per section, schema-versioned), `project_templates`, `project_key_sequences` ([10](../10-database-design.md)).

## 7. API endpoints
| Method | Path |
|---|---|
| POST | `/api/v1/projects` (body may include `templateId`, `draft: true`) |
| GET | `/api/v1/projects?cursor&filter` |
| GET/PATCH | `/api/v1/projects/{key}` |
| POST | `/api/v1/projects/{key}:archive` · `:restore` · `:clone` |
| DELETE | `/api/v1/projects/{key}` (archived only) |
| GET/POST | `/api/v1/projects/{key}/environments` · PATCH/DELETE `/environments/{id}` |
| GET | `/api/v1/projects/{key}/bindings` |
| PUT | `/api/v1/projects/{key}/bindings/{role}` (body: `connectionId`, `config`, `mode: replace|add`) returns capability check result |
| POST | `/api/v1/projects/{key}/bindings/{role}:validate` (dry-run) |
| GET/PUT | `/api/v1/projects/{key}/settings/{section}` |
| POST | `/api/v1/projects/{key}/health:check` (async op) |
| GET | `/api/v1/project-templates` |

## 8. Business rules
- BR-M02-1: The project key matches `^[A-Z][A-Z0-9]{1,9}$`. It is unique per organization and **immutable** because human-readable keys embed it.
- BR-M02-2: A binding can be activated only if the connection satisfies all **required** capabilities for the role ([12 §3](../12-provider-contracts.md)). Missing optional capabilities are shown as warnings.
- BR-M02-3: Replacing a binding never deletes history. The old binding row gets `ended_at`, and ExternalRefs keep their `connection_id` ([11 §6](../11-provider-architecture.md)).
- BR-M02-4: A project can have several `requirements` bindings. Every other role has at most one active binding.
- BR-M02-5: Environments flagged `is_production` cannot be targets for runs, unless the execution policy explicitly allows `smoke_readonly` runs and a `qa_lead` approves each run.
- BR-M02-6: Settings changes are versioned (`project_settings_history`) and audited. AI budget decreases apply immediately. Increases need `qa_lead` or above.
- BR-M02-7: Deleting a project requires that no runs are active. Data is soft-deleted, purged after 30 days, and audit events are kept per the retention policy.

## 9. Permissions
`project.create`, `project.read`, `project.update`, `project.bindings.manage`, `project.environments.manage`, `project.settings.manage`, `project.archive`, `project.delete`. See matrix [M13 §9](M13-team-permissions.md).

## 10. Provider dependencies
Uses M03 to list connections and their capability manifests, and to run validation (`connection.test`, `repo.read` on the selected repository, `issues.metadata.read` for the tracker).

## 11. Events & workflow integration
Emits `project.created`, `project.updated`, `project.binding.changed`, `project.archived`, `environment.changed` (outbox). The class-E job `bindings.health-check` runs every 6 hours per project. `project.binding.changed` triggers a resync of affected sources (class E).

## 12. Security requirements
- Environment secrets (test login credentials, storage state) are stored only as SecretStore references. They are never returned in API responses; the API shows a masked hint and last-rotated time.
- Allowed hosts are validated against SSRF rules: no link-local or metadata IPs, and no internal QualityOS service names ([21 §8](../21-security-architecture.md)).
- Only `org_admin` can bind org connections to projects. This stops a project lead from binding a connection meant for other projects.

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| Wizard step validation fails (e.g. repo not accessible with token) | Inline error with provider error code + remediation ("Token lacks `contents:read` on repo X") |
| Health check times out | Binding status `unknown`, retry with backoff, banner on project overview |
| Binding change while runs active | Allowed for future work; active runs keep their resolved binding snapshot (stored in run record) |
| Template schema older than current settings schema | Migrated on read via versioned settings migrations |

## 14. Edge cases
Two projects sharing one repository (allowed, warned). A test repository equal to the application repository (allowed in `app_repo_folder` mode only). Projects with no issue tracker use the internal tracker by default.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M02-AC-01 | A project can be created through the wizard in demo mode using mock connections, and its overview shows all bindings healthy. |
| M02-AC-02 | Binding a connection missing a required capability is rejected with a capability diff listing the missing items. |
| M02-AC-03 | Two projects configured with different repository providers (GitHub mock, GitLab mock) operate independently: syncing one never touches the other's data. |
| M02-AC-04 | Changing the issue-tracker binding keeps all existing defects' external links working, and new defects go to the new tracker. |
| M02-AC-05 | Environment secret values are never present in any API response or log (verified by a log scan test). |
| M02-AC-06 | Project keys are immutable. A PATCH that tries to change the key returns 422. |
| M02-AC-07 | Archiving a project makes all its write endpoints return 409 `project_archived`, and the project disappears from default lists. |
| M02-AC-08 | Every settings change creates an audit event and a settings history version. |

## 16. Implementation tasks
T-P2-10 (projects aggregate + key sequences), T-P2-11 (environments), T-P2-12 (bindings + capability check), T-P2-13 (settings sections + versioning), T-P2-14 (templates + clone), T-P2-15 (wizard UI), T-P2-16 (settings UI), T-P2-17 (health check job + panel), T-P2-18 (archive/restore/delete), T-P2-19 (overview page).

## 17. Testing requirements
- Unit: key validation, capability matching.
- Integration: binding change preserves ExternalRefs.
- E2E: wizard in demo mode.
- Isolation: cross-project access is denied.

## 18. Dependencies & technical risks
Depends on M03 (connections), M13 (members), M14 (secrets, audit). Risk: settings sprawl. Mitigation: typed, versioned setting sections with JSON Schema in `@qos/contracts`.
