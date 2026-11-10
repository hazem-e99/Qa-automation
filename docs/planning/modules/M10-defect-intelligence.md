# M10 — AI Defect Intelligence

> Status: **Planned** · Phases: P4 (internal defects, manual drafts), P8 (failure analysis, duplicates, AI drafts, external sync, verification) · Owner: AI Engineer + Backend · Workflows: [19 WF-C, WF-D](../19-workflow-specifications.md)

## 1. Purpose & responsibilities
This module turns failures into reproducible, de-duplicated, and well-classified defects. It syncs approved defects to the configured tracker and follows them through fix verification. It covers:
- failure classification
- clustering of related failures
- duplicate detection
- root-cause hints
- bug report drafting
- the defect lifecycle and its approval flow
- external issue sync
- tracking re-verification after a fix

## 2. Roles
- `qa_engineer`: creates and edits drafts.
- `qa_lead` (or whoever the policy names): approves drafts and external sync.
- `qc_reviewer`: reviews defect quality.
- `developer`: reads defects and comments. A developer marks a fix by linking it in the code (commit message) or setting the state in the external tracker.

## 3. Features
| ID | Feature |
|---|---|
| M10-FR-01 | Internal defect model (works without external tracker): key `PRJ-D-n`, title, description, steps to reproduce, expected/actual, severity (S1–S4), priority (P1–P4), environment, build, component, labels, evidence, links (requirement versions, test case versions, executions), state |
| M10-FR-02 | Failure analysis (P8): for each failed final result: deterministic signals first (error type, assertion vs timeout vs network vs infra exit codes, HTTP 5xx in trace, selector-not-found, environment pre-flight status, flaky history) → AI task `failures.classify` with evidence digest → classification + confidence + rationale + evidence pointers |
| M10-FR-03 | Clustering: group failures in a run by normalized error signature (stack frame fingerprint + message template) and AI-assisted merge for semantically similar ones → one cluster = one candidate defect |
| M10-FR-04 | Duplicate detection: candidate vs open/recent defects (internal + synced external) using signature match + embedding similarity + same requirement/test link; shows top 3 with scores and "why" |
| M10-FR-05 | Root-cause hints: likely layer (frontend/API/data/env), suspect recent commits in app repo (commits touching files related to failing area via change-impact map, P8 optional), network evidence; always labelled hypothesis |
| M10-FR-06 | Bug report drafting: task `defects.draft` produces structured report: title, summary, steps (from test case version steps + trace actions), expected vs actual, environment, evidence list, suggested severity/priority with rationale |
| M10-FR-07 | Approval per policy: e.g., "S1/S2 require qa_lead", "internal tracker drafts auto-approve allowed for S4 only", default all require human approval |
| M10-FR-08 | External sync: on approval, create issue via `IssueTracker` port; attach/inline evidence (links to QualityOS signed views, or upload attachments if `issues.attachments.create` + policy); store ExternalRef; bidirectional state sync via mappings (external state changes → internal state) |
| M10-FR-09 | Defect lifecycle: `draft → pending_approval → open → in_progress → fix_candidate → resolved → verified → closed`; side states `rejected`, `duplicate`, `wont_fix`, `failed_verification` → back to `open` |
| M10-FR-10 | Fix detection: commit message references (`Fixes PRJ-D-12`, `AB#1234`, `#45` per provider conventions) on configured branches; PR merge events linking; external state "Resolved" → `fix_candidate`/`resolved` |
| M10-FR-11 | Verification: on fix candidate, create retest (automated run for linked bindings and/or manual retest execution) → result → `verified` / `failed_verification` / `inconclusive` |
| M10-FR-12 | External update after verification (policy-gated): add comment with verification evidence; optionally transition external state (e.g., to "Closed") only if policy `allow_external_close=true` |
| M10-FR-13 | Defect list/board with filters, saved views; SLA timers optional |
| M10-FR-14 | Feedback capture: every human override of classification/severity/duplicate decision stored as evaluation data |

## 4. User journeys
J4 (manual defect), J6 (failure triage → approval → Azure Boards), J7 (verification).

## 5. UI screens
- `S-DEF-01` Defect list/board
- `S-DEF-02` Defect detail: header with state and external link chip, report, evidence gallery, trace links, linked items, activity, sync status
- `S-DEF-03` Draft review: side-by-side draft vs evidence; duplicate candidates panel; severity rationale; Approve and send / Edit / Mark duplicate / Discard
- `S-EXE-04` (shared) Failure analysis tab: clusters, classifications, confidence, rationale
- `S-DEF-04` Verification panel

## 6. Domain entities
`defects`, `defect_drafts` (AI or human; content + provenance), `failure_analyses` (per result attempt: deterministic signals, AI classification, confidence, model ref), `failure_clusters`, `cluster_members`, `duplicate_candidates`, `defect_links` (via `traceability_links`), `defect_verifications`, `external_refs` (issue), `defect_state_history`, `defect_embeddings`, `annotations` (classification overrides on immutable results).

## 7. API endpoints
| Method | Path |
|---|---|
| GET/POST | `/api/v1/projects/{key}/defects` · GET/PATCH `/{defKey}` |
| POST | `/api/v1/projects/{key}/defects/{defKey}:transition` (to, reason) |
| GET | `/api/v1/projects/{key}/defect-drafts?status` · GET/PATCH `/{id}` |
| POST | `/api/v1/projects/{key}/defect-drafts/{id}:approve` · `:reject` · `:mark-duplicate` (targetDefKey) |
| GET | `/api/v1/projects/{key}/runs/{runKey}/failure-analysis` · POST `:reanalyze` |
| POST | `/api/v1/projects/{key}/results/{resultId}/classification` (override → annotation) |
| POST | `/api/v1/projects/{key}/defects/{defKey}:verify` (trigger retest) |
| GET | `/api/v1/projects/{key}/defects/{defKey}/sync` · POST `:resync` |
| POST | `/automation/v1/defects/{defKey}/retest` (n8n, Idempotency-Key) |

## 8. Business rules
- BR-M10-1: **AI confidence is never proof.** Classification and duplicate decisions from AI are *suggestions*. External issues are created only after approval under policy. The default policy requires approval for every external creation.
- BR-M10-2: A draft cannot be approved without at least one evidence item for automated failures (trace, screenshot, or log) or for manual ones (step actual result or attachment).
- BR-M10-3: External creation is idempotent. The idempotency key `defect:{id}:create` is stored before the call. On retry, the adapter first searches for an existing issue by the embedded marker (`[QOS:PRJ-D-12]` in the description or a custom field), so duplicates are never created after a timeout.
- BR-M10-4: The internal state is authoritative for QualityOS verification. External state changes map through `status_mappings`. If they conflict (external "Closed" while verification `failed_verification`), a sync conflict is flagged for a human.
- BR-M10-5: Marking a draft duplicate links its evidence to the existing defect, adds an occurrence count, and optionally comments on the external issue (policy).
- BR-M10-6: `verified` requires a retest whose result is `passed` on a build/commit that is newer than or equal to the fix reference. A flaky pass (fail then pass) yields `inconclusive`.
- BR-M10-7: Severity uses the project's scale. AI suggestions must include a rationale that cites evidence.
- BR-M10-8: Failures classified `test_defect` route to M07 maintenance proposals, not to product defects. `infrastructure` and `environment` route to platform health alerts.

## 9. Permissions
`defect.read`, `defect.create`, `defect.edit`, `defect.transition`, `defect.draft.approve`, `defect.external.sync`, `classification.override`, `defect.verify`.

## 10. Provider dependencies
**Required** `IssueTracker` capabilities:
- `issues.create@1`
- `issues.get@1`
- `issues.update@1`
- `issues.list_changed@1`
- `issues.metadata.read@1` (types, states, fields)

**Optional:**
- `issues.comment@1`
- `issues.attachments.create@1`
- `issues.search_by_marker@1`
- `issues.links@1`
- `issues.transition@1`

**Other ports:**
- `RepositoryProvider`: `repo.commits.list@1` and `repo.pr.read@1`, for fix detection.
- AI tasks: `failures.classify`, `failures.cluster_merge`, `defects.draft`, `defects.embed`, `defects.duplicate_judge`.

Adapters: Internal (always available), Azure Boards (P8), GitHub Issues (P8), GitLab Issues (P13).

## 11. Events & workflow integration
Emits:
- `failure.analyzed`
- `defect.draft.created`
- `defect.draft.approved`
- `defect.created`
- `defect.external.created`
- `defect.state.changed`
- `defect.fix_candidate`
- `defect.verification.completed`
- `defect.sync.conflict`

Class E jobs:
- `failures.analyze` (after `run.finalized`)
- `defects.sync.push` (after approval)
- `sync.poll` (issue tracker)
- `fix.detect` (on repo changes)

Class O-F:
- Retest creation on fix candidate. n8n primary ("Bug retest requested" workflow); core fallback `retest.create`.

Class O:
- "Bug report prepared → notify approvers"
- "Bug status changed → notify tester"

## 12. Security requirements
- Evidence sent to external trackers defaults to **links** that point to QualityOS signed views, which require login. Uploading attachments to the external tracker needs a policy opt-in, because external trackers have different access controls.
- Drafts are redacted before AI processing and before external send (tokens, emails, custom patterns).
- External content pulled back (comments, descriptions) is treated as untrusted (prompt injection defence, HTML sanitization).

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| Tracker API down during push | Defect stays `open` internally with sync status `pending`; retry with backoff; DLQ → visible "Sync failed" with retry button |
| Timeout after create request (unknown outcome) | Marker search before retry (BR-M10-3) |
| Required field missing in Azure (custom mandatory field) | Discovered via `issues.metadata.read`; mapping UI requires default value; push fails with explicit field name if still missing |
| AI classification unavailable | Deterministic classification only (`unknown` where unsure); drafts created from template |
| Duplicate judged wrongly | Undo (unlink) available; override captured for eval |

## 14. Edge cases
- The same failure across 20 tests (environment down) becomes one cluster classified `environment`. Defect creation is suppressed and an environment alert is raised.
- An external issue is deleted, so the ExternalRef is marked `deleted_externally` and the internal defect is kept.
- A defect is linked to several requirements, and coverage shows it on each of them.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M10-AC-01 | A failed automated test produces a failure analysis with a deterministic signal summary, a classification, a confidence, and a rationale referencing at least one evidence item. |
| M10-AC-02 | 10 failures with the same error signature in one run form a single cluster and a single draft. |
| M10-AC-03 | With the default policy, no external issue is created without a human approval event recorded in the audit. |
| M10-AC-04 | Simulating a timeout after the tracker created the issue results in exactly one external issue after retry (marker search). |
| M10-AC-05 | An approved draft creates an Azure Boards work item (mock/recorded) with mapped type, state, severity, and an ExternalRef stored and displayed. |
| M10-AC-06 | Commit "Fixes PRJ-D-7" on the default branch moves the defect to `fix_candidate` and creates a retest. A passing retest marks it `verified`, and a flaky pass marks it `inconclusive`. |
| M10-AC-07 | External state "Closed" while internal verification failed raises a sync conflict and does not mark the defect verified. |
| M10-AC-08 | Overriding an AI classification stores an annotation, and the original immutable result is unchanged. |
| M10-AC-09 | Switching the project tracker from Azure Boards to the internal tracker keeps the external links of existing defects, and new defects are internal. |

## 16. Implementation tasks
**P4:**
- T-P4-40 internal defect aggregate + lifecycle
- T-P4-41 defect list/detail UI
- T-P4-42 manual draft from execution
- T-P4-43 traceability links for defects
- T-P4-44 approval policy hook for defects
- T-P4-45 defect state history
- T-P4-46 internal tracker adapter (IssueTracker port reference implementation)

**P8:**
- T-P8-01 deterministic failure signal extractor
- T-P8-02 `failures.classify` task + eval set
- T-P8-03 clustering
- T-P8-04 embeddings + duplicate candidates
- T-P8-05 `defects.draft` task
- T-P8-06 draft review UI
- T-P8-07 external push with idempotent marker
- T-P8-08 status/field mapping application
- T-P8-09 issue tracker sync poll
- T-P8-10 Azure Boards IssueTracker adapter
- T-P8-11 GitHub Issues adapter
- T-P8-12 fix detection
- T-P8-13 verification orchestration + retest creation
- T-P8-14 sync conflicts
- T-P8-15 quality gates (M08)
- T-P8-16 feedback capture → eval datasets
- T-P8-17 environment-failure suppression
- T-P8-18 root-cause hints (optional)

## 17. Testing requirements
- Failure-classification eval set: 150 labelled failures from demo apps with seeded bugs, flaky tests, environment outages, and test bugs. Targets in [15 §10](../15-ai-agent-architecture.md).
- Idempotency tests for push.
- Mapping tests per adapter.
- E2E for WF-C and WF-D in demo mode.

## 18. Dependencies & technical risks
Depends on M08 (results), M03 (trackers), M14 (policies), and the AI Gateway.

| Risk | Mitigation |
|---|---|
| Misclassification reduces trust | Deterministic signals first, visible confidence, mandatory approval, measured precision |
| Azure custom-field variability | Metadata discovery + mapping lint |
