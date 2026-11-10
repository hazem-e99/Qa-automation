# M05 — AI Test Studio

> Status: **Planned** · Phases: P4 (structured test management + manual authoring), P5 (AI suggestions, coverage gaps, review queue) · Owner: QA Automation Architect + AI Engineer · Engine: [16](../16-test-management-engine.md), AI: [15](../15-ai-agent-architecture.md)

## 1. Purpose & responsibilities
The AI Test Studio is where test cases are designed and kept. Manual and automated tests live in one model. It is responsible for:
- structured test cases, with versions
- suites
- tags
- linking test cases to requirement versions
- AI-generated suggestions of each test type
- detecting coverage gaps
- the review and approval queue
- the automation status lifecycle that hands work to M07

## 2. Roles
- Author: `qa_engineer`, `qa_lead`.
- Approve (when policy requires): `qa_lead`, `qc_reviewer`.
- Developers can comment and propose edits, but cannot approve by default.
- Viewers can read.

## 3. Features
| ID | Feature |
|---|---|
| M05-FR-01 | Test case model: title, description, preconditions, test data (structured key/values + data-set reference), steps (action, data, expected result), overall expected result, priority (P0–P3), type (functional, negative, boundary, edge, exploratory-charter, accessibility, security-check, api, visual, performance-smoke), tags, components, automation status, requirement references (to specific RequirementVersion + AC), estimated duration, owner |
| M05-FR-02 | Versioning: every saved change to an approved test case creates a new draft TestCaseVersion; executions reference the exact version run |
| M05-FR-03 | Suites: static (ordered list) and dynamic (saved query: tags/type/priority/component/requirement). Nested folders for organization (not for semantics) |
| M05-FR-04 | AI generation (P5): select approved requirements → choose types + depth (lean/standard/thorough) → task `tests.suggest` returns structured cases with AC coverage mapping and rationale |
| M05-FR-05 | Exploratory charters: AI suggests charters (mission, areas, risks, time box) for M06 sessions |
| M05-FR-06 | Accessibility suggestions: WCAG 2.2-oriented checks (keyboard, focus order, labels, contrast) mapped to requirement screens; automated candidates flagged for axe-core checks in Playwright |
| M05-FR-07 | Security-related checks (safe scope only): input validation, authz boundary, session handling, error leakage — **as test ideas against the project's own non-production environments**; no exploit payload generation, no third-party targets |
| M05-FR-08 | Coverage gap analysis: per requirement and AC — which AC have no approved test; which types missing (e.g., no negative test); shown as a heatmap |
| M05-FR-09 | Review queue: AI suggestions and human drafts awaiting approval; actions Accept / Edit & accept / Reject (reason codes: duplicate, out of scope, incorrect expected result, too vague, not testable, other) |
| M05-FR-10 | Duplicate detection among test cases (embedding similarity) at suggestion time |
| M05-FR-11 | Bulk operations: tag, move to suite, change priority, set automation status, export |
| M05-FR-12 | Import: CSV/XLSX test cases (column mapping), and from other tools' CSV exports (TestRail-like format) |
| M05-FR-13 | Automation status lifecycle: `manual_only` / `candidate` / `in_progress` (code generation or manual automation underway) / `automated` (active binding) / `automation_broken` (binding resolves to no test or consistently errors) / `retired` |
| M05-FR-14 | Test case quality checklist (configurable): clear title, ≥1 expected result per step, preconditions present, linked requirement, no ambiguous words; score shown as checklist, not a magic number |
| M05-FR-15 | Shared steps (reusable step blocks, versioned) |

## 4. User journeys
J3 (AI-assisted design), J5 (marking candidates for automation), J8 (updating tests after a requirement change).

## 5. UI screens
- `S-TST-01` Test case library: tree of suites or flat list, filters, columns, and bulk bar.
- `S-TST-02` Test case editor: structured form, step grid with keyboard navigation, linked requirements panel, version history, and an "AI improve wording" action.
- `S-TST-03` AI generation workspace:
  - left: requirement picker showing coverage status
  - center: suggestion cards grouped by requirement and AC
  - right: details and edit panel
  - top: type and depth selectors and the estimated cost
- `S-TST-04` Review queue: a table with inline diff for edits, plus reason capture.
- `S-TST-05` Coverage heatmap (requirements × test types).
- `S-TST-06` Suite builder (static drag-order or dynamic query builder).

## 6. Domain entities
`test_cases`, `test_case_versions` (immutable once approved), `test_steps` (per version), `shared_step_blocks` + versions, `test_suites`, `suite_items`, `suite_queries`, `test_case_requirement_links` (stored as `traceability_links` type `verifies` with AC granularity), `test_reviews`, `ai_suggestions` (raw suggestion + disposition), `test_case_embeddings`, `automation_bindings` (owned by M07/M08, displayed here).

## 7. API endpoints
| Method | Path |
|---|---|
| GET/POST | `/api/v1/projects/{key}/test-cases` |
| GET/PATCH | `/api/v1/projects/{key}/test-cases/{tcKey}` (PATCH on approved → new draft version) |
| GET | `/api/v1/projects/{key}/test-cases/{tcKey}/versions` · `/diff?from&to` |
| POST | `/api/v1/projects/{key}/test-cases/{tcKey}/versions/{n}:submit` · `:approve` · `:reject` |
| POST | `/api/v1/projects/{key}/test-cases:bulk` |
| POST | `/api/v1/projects/{key}/test-cases:import` (multipart + mapping) |
| GET/POST | `/api/v1/projects/{key}/suites` · PATCH/DELETE `/{id}` · PUT `/{id}/items` |
| POST | `/api/v1/projects/{key}/ai/test-suggestions` (body: requirementVersionIds, types, depth) → operation |
| GET | `/api/v1/projects/{key}/ai/test-suggestions/{opId}` |
| POST | `/api/v1/projects/{key}/ai/suggestions/{id}:accept` · `:reject` (with edits/reason) |
| GET | `/api/v1/projects/{key}/coverage/matrix` |
| GET/POST | `/api/v1/projects/{key}/shared-steps` |

## 8. Business rules
- BR-M05-1: A test case can be executed in an official cycle only when it has an **approved** version, or when the project policy `allow_draft_execution` is set (exploratory use).
- BR-M05-2: AI suggestions are stored as `ai_suggestions`. They become test cases only on Accept, which creates a version in `draft`, or in `approved` when the accepting user holds approval rights and policy allows single-step approval.
- BR-M05-3: Each suggestion must reference ≥1 approved RequirementVersion and the specific AC it covers. If not, schema validation rejects it.
- BR-M05-4: Expected results produced by AI must trace to source requirement text or to an AC. Suggestions whose expected results rely on inferred behavior are flagged `assumption` and listed explicitly.
- BR-M05-5: When a linked RequirementVersion is superseded, the test case's link is marked `outdated` and the test case gets `needs_review`. Execution stays allowed, but results show the outdated-link warning.
- BR-M05-6: The automation status changes to `automated` only through M07/M08 binding activation. It is never set by hand.
- BR-M05-7: Security-check suggestions are restricted by a safety policy. The prompt and output schema forbid exploit code and any target outside the project's environments ([15 §8](../15-ai-agent-architecture.md)).

## 9. Permissions
`testcase.read`, `testcase.create`, `testcase.edit`, `testcase.submit`, `testcase.approve`, `suite.manage`, `ai.tests.generate` (budget-consuming), `testcase.import`.

## 10. Provider dependencies
AI Gateway tasks:
- `tests.suggest`
- `tests.suggest_charters`
- `tests.improve_wording`
- `tests.embed`
- `tests.suggest_updates` (with M04)

No repository dependency (M07 handles code).

## 11. Events & workflow integration
- Emits:
  - `testcase.version.created`
  - `testcase.version.approved`
  - `testcase.needs_review`
  - `testcase.automation.candidate_marked`
  - `ai.suggestions.ready`
- Class O workflows:
  - "Test cases approved → notify automation engineer"
  - "Candidate marked → request code generation". The workflow calls the Automation API, which creates an M07 job. The PR still requires human review.

## 12. Security requirements
- Prompt context includes only the selected requirement versions and project conventions, never other projects' data.
- Test data fields marked `sensitive` are stored as SecretStore references and masked in the UI.
- Imports are validated (size, row limit 10k, formula injection neutralized: cells starting with `=+-@` are prefixed when exported).

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| AI budget exhausted | Generation disabled with message + budget owner; manual authoring unaffected |
| AI returns cases referencing nonexistent AC | Dropped by validation; count shown ("3 suggestions discarded: invalid references") |
| Provider timeout | Operation retried per gateway policy; partial results shown per requirement batch |
| Concurrent edits | Optimistic concurrency (`version_etag`); conflict dialog with diff |

## 14. Edge cases
- Very long requirements are chunked per AC.
- Requirements with no AC: the AI is told to propose `inferred` AC first, which flow to M04 for approval. Test suggestions are then held until those AC are approved, or generated against the requirement text with the `assumption` flag.
- Deleting a suite never deletes its test cases.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M05-AC-01 | Generating suggestions for 5 approved requirements returns cases that each reference a valid RequirementVersion and AC, and none are persisted as test cases until accepted. |
| M05-AC-02 | Rejecting a suggestion requires a reason code, and rejection statistics appear in AI metrics (KPI-20). |
| M05-AC-03 | Editing an approved test case creates version n+1 in draft, and past executions still display version n. |
| M05-AC-04 | When a linked requirement gets a new approved version, the test case shows `needs_review` and an outdated-link warning. |
| M05-AC-05 | The coverage heatmap shows a requirement with no negative test as a gap, and the gap disappears after a negative test is approved. |
| M05-AC-06 | A test case's automation status cannot be set to `automated` via the API. The attempt returns 422. |
| M05-AC-07 | A CSV import of 500 test cases with mapping completes with a per-row error report, and formula-injection strings are neutralized. |
| M05-AC-08 | With the AI budget at 100%, the generate button is disabled with an explanatory message, and manual authoring still works. |

## 16. Implementation tasks
- P4: T-P4-01 (test case aggregate + versions + steps), T-P4-02 (suites static/dynamic), T-P4-03 (requirement links, AC granularity), T-P4-04 (editor UI), T-P4-05 (library UI + bulk), T-P4-06 (import CSV/XLSX), T-P4-07 (shared steps), T-P4-08 (approval flow + review queue for human drafts), T-P4-09 (quality checklist), T-P4-10 (coverage matrix query + heatmap UI).
- P5: T-P5-01 (AI Gateway core), T-P5-02 (Claude adapter + structured output), T-P5-03 (prompt registry + versioning), T-P5-04 (`tests.suggest` task + schema + eval set), T-P5-05 (generation workspace UI), T-P5-06 (suggestion dispositions + metrics), T-P5-07 (charters/accessibility/security-check variants), T-P5-08 (test-case embeddings + duplicate hints), T-P5-09 (budgets + cost estimate pre-check), T-P5-10 (redaction pipeline).

## 17. Testing requirements
- Unit tests on the versioning rules.
- Contract tests on the AI output schema.
- The eval set for `tests.suggest` covers 40 requirements with expert-written reference cases, scored on AC coverage, correctness of expected results, and duplicate rate ([15 §10](../15-ai-agent-architecture.md)).
- E2E: J3 in demo mode with the mock AI provider, which returns deterministic fixtures.

## 18. Dependencies & technical risks
Depends on M04 (approved requirements) and on the AI Gateway (P5).

| Risk | Mitigation |
|---|---|
| Suggestion volume overwhelms reviewers | Depth setting, dedupe, and per-requirement batch limits (default 8) |
| AI writes plausible but wrong expected results | Mandatory trace to requirement text or an AC, plus the `assumption` flag |
