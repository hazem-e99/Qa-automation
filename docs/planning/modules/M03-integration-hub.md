# M03 — Integration Hub

> Status: **Planned** · Phase: P2 (framework, GitHub/Azure DevOps/Claude/mocks), with adapters added in P3, P8, and P13 · Owner: Enterprise Integration Architect · Related: [11](../11-provider-architecture.md), [12](../12-provider-contracts.md), [13](../13-integration-design.md), [33](../33-provider-compatibility-matrix.md)

## 1. Purpose & responsibilities
The Integration Hub is the first-class place to manage external providers. It owns:
- the **provider catalog** (registered adapters and their capability manifests)
- **connections** (credentials, scope, health)
- **capability discovery and permission checks**
- **webhook endpoints and the inbox**
- **sync state** (cursors and errors)
- **field and status mappings**
- **external references**
- the safe **retirement** of connections

Business modules never call providers directly. They go through ports resolved by the registry.

## 2. Roles
- Org-level connections: `platform_admin` and `org_admin` can create and manage them.
- Mappings: `qa_lead` can edit mappings for projects they lead.
- Health: everyone with project access can see binding health.

## 3. Features
| ID | Feature |
|---|---|
| M03-FR-01 | Provider catalog: list adapters by family, with capability manifest, supported auth strategies, required scopes documentation, and status (`ga`, `beta`, `planned`) |
| M03-FR-02 | Create connection: choose provider type → auth strategy (`pat`, `github_app`, `entra_client_credentials`, `api_key`, `none` for local Git) → base URL/organization → credentials (stored in SecretStore) → **Test connection** |
| M03-FR-03 | Test connection: authenticates, reads identity, enumerates accessible scopes (repos/projects), verifies the permissions needed by each capability, and reports token expiry. Results are stored as `connection_checks` |
| M03-FR-04 | Capability discovery: static manifest from the adapter **intersected with** the live permission check. Gives the effective capabilities per connection (and per bound resource) |
| M03-FR-05 | Provider health: periodic checks, error rate over 24h, rate-limit headroom, last successful sync per binding, and token-expiry warnings (14 and 3 days) |
| M03-FR-06 | Sync status: per binding and source, the cursor, last run, items processed, errors (with drill-down), and buttons for "Sync now" and "Full resync" |
| M03-FR-07 | Mappings: status mapping (external ↔ canonical defect/requirement states), severity/priority mapping, field mapping (e.g. Azure `Microsoft.VSTS.Common.AcceptanceCriteria` → AC), work item type mapping, area/iteration path filters, label conventions |
| M03-FR-08 | Webhook setup: generates the endpoint URL `/webhooks/{connectionId}` and a secret, shows provider-specific setup instructions, can auto-register when the provider supports `webhooks.manage` and the user consents, and supports test delivery |
| M03-FR-09 | Inbox viewer: received deliveries with dedupe status, verification result, processing status, and replay (admin) |
| M03-FR-10 | Retry and recovery: failed sync items go to a retry queue with backoff. Dead-lettered items are visible with "Retry" and "Ignore with reason" |
| M03-FR-11 | Provider switching assistant: guided flow for WF-F (validate the new connection, map resources, dry-run, activate, retire the old one) |
| M03-FR-12 | Disconnect/retire connection: shows the impact analysis (bindings affected, ExternalRefs count, webhooks to remove). Retiring keeps the record read-only. Credential deletion is optional and separate |
| M03-FR-13 | Configuration validation: lint mappings (unmapped external statuses, duplicate mappings, unreachable canonical states) |
| M03-FR-14 | Credential rotation: replace the secret in place, re-run the test, and record the rotation in audit. The old secret is destroyed after a successful test |

## 4. User journeys
J1 (connect GitHub, Azure DevOps, and Claude), J9 (switch GitHub → GitLab). Credential rotation flow: an expiry warning notification → connection page → "Rotate" → paste the new PAT → test → done.

## 5. UI screens
- `S-INT-01` Integration Hub home: grid of connections grouped by family, with health chips
- `S-INT-02` Provider catalog (cards with capability badges)
- `S-INT-03` Connection setup wizard (auth strategy, credentials, test results with a permission checklist)
- `S-INT-04` Connection detail (tabs: Overview, Capabilities, Bindings, Sync, Webhooks, Inbox, Mappings, Audit)
- `S-INT-05` Mapping editor (two-column external ↔ canonical, with validation lint)
- `S-INT-06` Provider switch assistant (stepper)
- `S-INT-07` Retire connection dialog (impact summary + typed confirmation)

## 6. Domain entities
`provider_types` (seeded from code registry), `connections`, `connection_secrets` (SecretStore refs), `connection_checks`, `connection_capabilities` (effective), `project_bindings` (owned by M02, read here), `sync_cursors`, `sync_runs`, `sync_errors`, `inbox_messages`, `webhook_endpoints`, `external_refs`, `field_mappings`, `status_mappings` ([10](../10-database-design.md)).

## 7. API endpoints
| Method | Path |
|---|---|
| GET | `/api/v1/providers` (catalog with manifests) |
| GET/POST | `/api/v1/connections` |
| GET/PATCH | `/api/v1/connections/{id}` |
| POST | `/api/v1/connections/{id}:test` · `:rotate-secret` · `:retire` · `:reactivate` |
| GET | `/api/v1/connections/{id}/capabilities` · `/checks` · `/impact` |
| GET | `/api/v1/connections/{id}/resources?type=repository|project|board&search=` (discover repos/projects) |
| GET/PUT | `/api/v1/projects/{key}/mappings/{kind}` (status, severity, fields, types) |
| POST | `/api/v1/projects/{key}/mappings/{kind}:validate` |
| GET | `/api/v1/projects/{key}/sync` · POST `/sync/{bindingId}:run` (`mode=incremental|full`) |
| GET | `/api/v1/connections/{id}/inbox?status&cursor` · POST `/inbox/{msgId}:replay` |
| GET/POST | `/api/v1/connections/{id}/webhook` (get or create endpoint and secret) · POST `:register` · `:test` |
| POST | `/webhooks/{connectionId}` (public ingress; separate listener in local mode) |
| POST | `/api/v1/projects/{key}/provider-switch` (starts WF-F, returns an operation) |

## 8. Business rules
- BR-M03-1: Credentials are write-only through the API. Reads return `{hint: "ghp_…a1F3", lastRotatedAt, expiresAt}` only.
- BR-M03-2: Effective capability = manifest capability ∧ permission check passed ∧ adapter enabled. It is recomputed on every connection test and once a day.
- BR-M03-3: A connection referenced by an active binding cannot be retired. The binding must be replaced or ended first. A retired connection keeps its rows. Its ExternalRefs render from the stored snapshot, with the label "source retired".
- BR-M03-4: Inbox messages are unique on `(connection_id, dedupe_key)`. Duplicates are recorded as `duplicate` and not processed.
- BR-M03-5: Unsigned providers (Azure DevOps) are verified with Basic auth over HTTPS. The handler **must re-fetch** the referenced item; payload fields are not trusted ([13 §5](../13-integration-design.md)).
- BR-M03-6: Mappings must cover every external status seen during discovery before a tracker binding can be activated for defect sync (lint error otherwise).
- BR-M03-7: Sync runs per binding are serialized (pg-boss `stately`, keyed `binding:{id}`). A manual "Sync now" while a sync is active is queued as at most one pending sync.

## 9. Permissions
`connection.read`, `connection.manage`, `connection.secret.rotate`, `connection.retire`, `mapping.manage`, `sync.trigger`, `inbox.replay` (admin only).

## 10. Provider dependencies
This module **is** the provider boundary. Pilot adapters, by the phase that builds them:
- GitHub repository: P2
- Azure DevOps connection: P2
- Claude connection: P2
- LocalFS storage: P1
- Mocks for every family: P2
- Local Git: P2
- Azure Boards requirements: P3
- Internal tracker: P4
- Playwright engine and Local Docker backend: P6
- n8n orchestrator: P7
- Azure Boards and GitHub Issues trackers: P8

## 11. Events & workflow integration
- Emits:
  - `connection.created`
  - `connection.tested`
  - `connection.health.changed`
  - `connection.credential.expiring`
  - `connection.retired`
  - `sync.completed`
  - `sync.failed`
  - `external.item.changed` (normalized, per changed item)
- Class E jobs:
  - `sync.poll` (per binding schedule)
  - `inbox.process`
  - `connections.health-check`
  - `credentials.expiry-check`
- Class O: credential-expiry notifications delivered by n8n, with in-app fallback always present.

## 12. Security requirements
- Secrets use envelope encryption ([21 §6](../21-security-architecture.md)).
- The base URL is validated against an SSRF denylist, and the scheme must be https (except Local Git paths and explicitly allowed localhost providers in dev mode).
- The webhook listener:
  - is rate limited
  - limits body size (1 MB default)
  - verifies signatures or secrets with constant-time comparison
  - rejects unknown connection IDs with 404 and no timing difference
- Provider tokens never leave the API, worker, or controller processes. Sandboxes **never** receive provider credentials. Test code is delivered as a commit archive streamed by the API. The only exception is the codegen publisher container, which receives a branch-scoped write token ([M07 §12](M07-automated-test-generation.md)).
- Provider error bodies are sanitized before storage, so echoed tokens are stripped.

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| Provider 401 (token revoked/expired) | Connection health → `auth_failed`; syncs paused; notify admins; no retries until rotated |
| Provider 403 on a resource | Binding health `permission_denied` with the missing permission name |
| Rate limited (429 / secondary limits) | Respect `Retry-After`; adaptive backoff; sync resumes from cursor |
| Provider 5xx / network | Retry with exponential backoff (max 6 attempts); then DLQ + health `degraded` |
| Webhook signature invalid | 401, inbox record `rejected` (without body), alert after threshold |
| Cursor corruption / provider history rewrite | Full resync option; reconciliation compares external IDs and marks missing items `deleted_externally` (never hard-delete) |
| Laptop offline 3 days | Next poll pages from stored cursor; webhooks missed are irrelevant |

## 14. Edge cases
- A GitHub repository renamed or transferred: the stable numeric repo ID is used and the stored URL is updated.
- An Azure Boards work item moved to another project: the ID is preserved and the re-fetch updates the project.
- A provider that removes a field used in a mapping: mapping lint flags it.
- The same external item imported through two bindings: dedupe on `(provider_type, external_instance, external_id)`.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M03-AC-01 | Creating a GitHub connection with a token lacking `issues:write` shows effective capabilities without `issues.create`, and binding it as an issue tracker is rejected. |
| M03-AC-02 | Sending the same GitHub webhook delivery twice results in one processed inbox message and one `duplicate`. |
| M03-AC-03 | An Azure DevOps webhook whose payload claims title "X" while the API returns "Y" results in stored title "Y" (re-fetch enforced). |
| M03-AC-04 | With webhooks disabled, a change in the mock provider appears in QualityOS within one poll interval. |
| M03-AC-05 | Retiring a connection with historical ExternalRefs keeps every historical item viewable, with the snapshot and a "source retired" label. |
| M03-AC-06 | Secret values never appear in API responses, logs, audit diffs, or error records (automated scan over the test run logs). |
| M03-AC-07 | A PAT expiring in 10 days triggers exactly one in-app warning notification per day window, and an audit entry. |
| M03-AC-08 | Every adapter registered in the catalog passes its family's contract test suite in CI (mock and recorded-fixture modes). |
| M03-AC-09 | Mapping validation blocks activation when an external status discovered in the provider is unmapped. |

## 16. Implementation tasks
- P2:
  - T-P2-20 (provider registry + manifest types)
  - T-P2-21 (connections + SecretStore integration)
  - T-P2-22 (connection test + effective capabilities)
  - T-P2-23 (ExternalRef model + snapshots)
  - T-P2-24 (inbox + webhook listener + verification strategies)
  - T-P2-25 (sync framework: cursors, runs, errors, `stately` queue)
  - T-P2-26 (mock adapters for all families)
  - T-P2-27 (GitHub repository adapter: read, branches, PR)
  - T-P2-28 (Azure DevOps connection + auth strategies)
  - T-P2-29 (Claude AI provider connection test)
  - T-P2-30 (Integration Hub UI: home, catalog, setup wizard, detail)
  - T-P2-31 (health + expiry jobs)
  - T-P2-32 (mapping editor + lint)
  - T-P2-33 (retire/impact analysis)
  - T-P2-34 (contract test harness)
- P8: T-P8-10 (Azure Boards issue tracker adapter), T-P8-11 (GitHub Issues adapter).
- P13: T-P13-01 (GitLab repo/issues adapters), T-P13-02 (GitLab webhooks), T-P13-03 (Azure Repos adapter), T-P13-04 (S3 storage), T-P13-05 (CI adapters).

## 17. Testing requirements
- Contract suites per port ([24 §5](../24-testing-strategy.md)).
- Recorded-fixture tests for each real adapter (no live credentials needed in CI).
- Optional live smoke tests gated by environment variables.
- Webhook verification tests with valid, invalid, replayed, and oversized deliveries.

## 18. Dependencies & technical risks
Depends on M14 (SecretStore, audit) and the pg-boss framework (P1).

| Risk | Mitigation |
|---|---|
| Provider API drift | Contract tests on recorded fixtures plus a weekly optional live smoke |
| Rate limits during full resync | Paged, resumable sync with a budget per window |
