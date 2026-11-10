# 32 — Acceptance Criteria Matrix

> Status: **Planned**. Generated from the module specifications (§15 of each), with verification level, delivery phase, and business-requirement mapping added. Regenerate whenever a module's acceptance criteria change. CI keeps this file and the modules in sync (see [35](35-planning-audit.md) §4).

**How to read this matrix**
- **Primary verification** is the main automated test level that proves the criterion. Many criteria are also covered at other levels.
- An AC counts as *implemented* only when its test passes in CI ([25 §3](25-implementation-roadmap.md)).
- Business requirements are defined in [03](03-business-requirements.md).

## 1. Module acceptance criteria (111 criteria)
| AC | Module | Criterion | Primary verification | Phase | BR |
|---|---|---|---|---|---|
| M01-AC-01 | [M01](modules/M01-company-dashboard.md) | Given a user with access to 2 of 3 projects, the summary totals equal the sum over those 2 projects only (verified against seeded data). | Integration | P10 | BR-08 |
| M01-AC-02 | [M01](modules/M01-company-dashboard.md) | Every KPI tile opens a definition popover whose formula text matches [29](29-business-case-and-kpis.md). | E2E (Playwright, demo mode) | P10 | BR-08 |
| M01-AC-03 | [M01](modules/M01-company-dashboard.md) | Clicking the "Open critical defects" tile opens M10's list filtered to those defects, with an identical count. | E2E (Playwright, demo mode) | P4 (basic) / P10 | BR-08 |
| M01-AC-04 | [M01](modules/M01-company-dashboard.md) | When the latest analytics snapshot is older than 2 refresh intervals, a stale banner shows the snapshot time. | E2E (Playwright, demo mode) | P10 | BR-08 |
| M01-AC-05 | [M01](modules/M01-company-dashboard.md) | A project with <20 executions shows "insufficient data" instead of a pass-rate percentage. | E2E (Playwright, demo mode) | P10 | BR-08 |
| M01-AC-06 | [M01](modules/M01-company-dashboard.md) | The risk indicator shows its contributing factors, and changing a threshold in project settings changes the level on the next refresh. | E2E (Playwright, demo mode) | P10 | BR-08 |
| M01-AC-07 | [M01](modules/M01-company-dashboard.md) | Dashboard summary p95 response ≤ 500 ms with 50 projects and 1M results in seed data (NFR-PERF-02). | Performance | P10 | BR-08 |
| M02-AC-01 | [M02](modules/M02-project-management.md) | A project can be created through the wizard in demo mode using mock connections, and its overview shows all bindings healthy. | E2E (Playwright, demo mode) | P2 | BR-07, BR-10 |
| M02-AC-02 | [M02](modules/M02-project-management.md) | Binding a connection missing a required capability is rejected with a capability diff listing the missing items. | E2E (Playwright, demo mode) | P2 | BR-07, BR-10 |
| M02-AC-03 | [M02](modules/M02-project-management.md) | Two projects configured with different repository providers (GitHub mock, GitLab mock) operate independently: syncing one never touches the other's data. | Integration | P2 | BR-07, BR-10 |
| M02-AC-04 | [M02](modules/M02-project-management.md) | Changing the issue-tracker binding keeps all existing defects' external links working, and new defects go to the new tracker. | Integration | P2 | BR-07, BR-10 |
| M02-AC-05 | [M02](modules/M02-project-management.md) | Environment secret values are never present in any API response or log (verified by a log scan test). | Integration | P2 | BR-07, BR-10 |
| M02-AC-06 | [M02](modules/M02-project-management.md) | Project keys are immutable. A PATCH that tries to change the key returns 422. | Integration | P2 | BR-07, BR-10 |
| M02-AC-07 | [M02](modules/M02-project-management.md) | Archiving a project makes all its write endpoints return 409 `project_archived`, and the project disappears from default lists. | Integration | P2 | BR-07, BR-10 |
| M02-AC-08 | [M02](modules/M02-project-management.md) | Every settings change creates an audit event and a settings history version. | Integration | P2 | BR-07, BR-10 |
| M03-AC-01 | [M03](modules/M03-integration-hub.md) | Creating a GitHub connection with a token lacking `issues:write` shows effective capabilities without `issues.create`, and binding it as an issue tracker is rejected. | E2E (Playwright, demo mode) | P2 | BR-10 |
| M03-AC-02 | [M03](modules/M03-integration-hub.md) | Sending the same GitHub webhook delivery twice results in one processed inbox message and one `duplicate`. | Integration | P2 | BR-10 |
| M03-AC-03 | [M03](modules/M03-integration-hub.md) | An Azure DevOps webhook whose payload claims title "X" while the API returns "Y" results in stored title "Y" (re-fetch enforced). | Integration | P3 | BR-10 |
| M03-AC-04 | [M03](modules/M03-integration-hub.md) | With webhooks disabled, a change in the mock provider appears in QualityOS within one poll interval. | Integration | P2 | BR-10 |
| M03-AC-05 | [M03](modules/M03-integration-hub.md) | Retiring a connection with historical ExternalRefs keeps every historical item viewable, with the snapshot and a "source retired" label. | Integration | P2 | BR-10 |
| M03-AC-06 | [M03](modules/M03-integration-hub.md) | Secret values never appear in API responses, logs, audit diffs, or error records (automated scan over the test run logs). | Security | P2 | BR-10 |
| M03-AC-07 | [M03](modules/M03-integration-hub.md) | A PAT expiring in 10 days triggers exactly one in-app warning notification per day window, and an audit entry. | Integration | P2 | BR-10 |
| M03-AC-08 | [M03](modules/M03-integration-hub.md) | Every adapter registered in the catalog passes its family's contract test suite in CI (mock and recorded-fixture modes). | Contract | P2 | BR-10 |
| M03-AC-09 | [M03](modules/M03-integration-hub.md) | Mapping validation blocks activation when an external status discovered in the provider is unmapped. | Integration | P2 | BR-10 |
| M04-AC-01 | [M04](modules/M04-requirements-intelligence.md) | A project with three sources (mock Azure Boards, one DOCX, one XLSX) produces one unified requirement list. Each requirement shows its source(s) and a working locator… | E2E (Playwright, demo mode) | P3 | BR-06, BR-14 |
| M04-AC-02 | [M04](modules/M04-requirements-intelligence.md) | An inferred acceptance criterion cannot be approved by bulk-approve unless the "includes inferred" confirmation is given, and the audit records it. | Integration | P3 / P5 | BR-06, BR-14 |
| M04-AC-03 | [M04](modules/M04-requirements-intelligence.md) | Updating an approved Azure work item (mock) creates a new draft version. The approved version remains effective, and linked tests are flagged `needs_review`. | Integration | P3 | BR-06, BR-14 |
| M04-AC-04 | [M04](modules/M04-requirements-intelligence.md) | Uploading v2 of a PDF shows a diff with added, changed, and removed requirements, and lists every affected test case. | E2E (Playwright, demo mode) | P3 | BR-06, BR-14 |
| M04-AC-05 | [M04](modules/M04-requirements-intelligence.md) | A conflict between two sources blocks approval of both requirements until it is resolved or waived. | E2E (Playwright, demo mode) | P5 | BR-06, BR-14 |
| M04-AC-06 | [M04](modules/M04-requirements-intelligence.md) | An Arabic DOCX is parsed with correct RTL rendering in the review UI, and searching "الدخول" finds a requirement containing "الدُّخول" (diacritics-insensitive). | E2E (Playwright, demo mode) | P3 | BR-06, BR-14 |
| M04-AC-07 | [M04](modules/M04-requirements-intelligence.md) | A scanned PDF yields blocks with OCR confidence, and items below the threshold are excluded from bulk-accept. | Integration | P3 | BR-06, BR-14 |
| M04-AC-08 | [M04](modules/M04-requirements-intelligence.md) | Uploading a password-protected PDF or a disguised executable is rejected, and nothing is passed to the parser. | Security | P3 | BR-06, BR-14 |
| M04-AC-09 | [M04](modules/M04-requirements-intelligence.md) | Downstream test design (M05) behaves identically for requirements from Azure, PDF, XLSX, and manual sources (same E2E scenario run four times). | E2E (Playwright, demo mode) | P3 | BR-06, BR-14 |
| M04-AC-10 | [M04](modules/M04-requirements-intelligence.md) | The duplicate suggestion between a story and a PDF item at similarity ≥ threshold can be merged, and the merged requirement keeps both provenances. | E2E (Playwright, demo mode) | P5 | BR-06, BR-14 |
| M05-AC-01 | [M05](modules/M05-ai-test-studio.md) | Generating suggestions for 5 approved requirements returns cases that each reference a valid RequirementVersion and AC, and none are persisted as test cases until acce… | E2E (Playwright, demo mode) | P5 | BR-02, BR-04, BR-09 |
| M05-AC-02 | [M05](modules/M05-ai-test-studio.md) | Rejecting a suggestion requires a reason code, and rejection statistics appear in AI metrics (KPI-20). | E2E (Playwright, demo mode) | P5 | BR-02, BR-04, BR-09 |
| M05-AC-03 | [M05](modules/M05-ai-test-studio.md) | Editing an approved test case creates version n+1 in draft, and past executions still display version n. | Integration | P4 | BR-02, BR-04, BR-09 |
| M05-AC-04 | [M05](modules/M05-ai-test-studio.md) | When a linked requirement gets a new approved version, the test case shows `needs_review` and an outdated-link warning. | E2E (Playwright, demo mode) | P4 | BR-02, BR-04, BR-09 |
| M05-AC-05 | [M05](modules/M05-ai-test-studio.md) | The coverage heatmap shows a requirement with no negative test as a gap, and the gap disappears after a negative test is approved. | E2E (Playwright, demo mode) | P4 | BR-02, BR-04, BR-09 |
| M05-AC-06 | [M05](modules/M05-ai-test-studio.md) | A test case's automation status cannot be set to `automated` via the API. The attempt returns 422. | Integration | P4 | BR-02, BR-04, BR-09 |
| M05-AC-07 | [M05](modules/M05-ai-test-studio.md) | A CSV import of 500 test cases with mapping completes with a per-row error report, and formula-injection strings are neutralized. | Integration | P4 | BR-02, BR-04, BR-09 |
| M05-AC-08 | [M05](modules/M05-ai-test-studio.md) | With the AI budget at 100%, the generate button is disabled with an explanatory message, and manual authoring still works. | Integration | P5 | BR-02, BR-04, BR-09 |
| M06-AC-01 | [M06](modules/M06-manual-testing-workspace.md) | A tester can execute a 10-step test case with only the keyboard, and each step is persisted within 1 s of its status key. | E2E (Playwright, demo mode) | P4 | BR-05, BR-06 |
| M06-AC-02 | [M06](modules/M06-manual-testing-workspace.md) | Marking any step failed sets the execution to failed. Override needs a reason, which is audited. | Integration | P4 | BR-05, BR-06 |
| M06-AC-03 | [M06](modules/M06-manual-testing-workspace.md) | "Create defect" from a failed step opens a draft that contains the steps up to the failure, the expected vs actual result, the environment, the build, and the attached… | E2E (Playwright, demo mode) | P4 | BR-05, BR-06 |
| M06-AC-04 | [M06](modules/M06-manual-testing-workspace.md) | With the network disconnected for 2 minutes during execution, no step results are lost, and no duplicates are created after reconnection. | Integration | P4 | BR-05, BR-06 |
| M06-AC-05 | [M06](modules/M06-manual-testing-workspace.md) | Reopening a completed execution creates attempt 2, and attempt 1 is still visible in history. | Integration | P4 | BR-05, BR-06 |
| M06-AC-06 | [M06](modules/M06-manual-testing-workspace.md) | When a linked defect becomes `fix_candidate`, a retest execution is proposed to the original tester within one dispatch cycle. | Integration | P4 | BR-05, BR-06 |
| M06-AC-07 | [M06](modules/M06-manual-testing-workspace.md) | The cycle dashboard counts match the execution table for the same filters. | E2E (Playwright, demo mode) | P4 | BR-05, BR-06 |
| M06-AC-08 | [M06](modules/M06-manual-testing-workspace.md) | An uploaded JPEG has its EXIF metadata stripped, and an SVG upload is converted to PNG or rejected. | Security | P4 | BR-05, BR-06 |
| M07-AC-01 | [M07](modules/M07-automated-test-generation.md) | Generating automation for 3 approved test cases against the demo app creates a `qos/gen/*` branch and PR. Each test title contains `@tc:` tags, and the PR description… | Integration | P9 | BR-01, BR-02 |
| M07-AC-02 | [M07](modules/M07-automated-test-generation.md) | QualityOS refuses any push to the default branch, verified by an adapter contract test and an integration test. | Contract | P9 | BR-01, BR-02 |
| M07-AC-03 | [M07](modules/M07-automated-test-generation.md) | A fix proposal whose diff removes an `expect` call is blocked by the diff guard, and no PR is created. | Integration | P9 | BR-01, BR-02 |
| M07-AC-04 | [M07](modules/M07-automated-test-generation.md) | After the PR merges to the default branch (mock provider), bindings activate within one poll interval, and the test cases show `automated`. | Integration | P9 | BR-01, BR-02 |
| M07-AC-05 | [M07](modules/M07-automated-test-generation.md) | Renaming a bound test to drop its tag marks the binding `automation_broken` on the next discovery and notifies the owner. | Integration | P9 | BR-01, BR-02 |
| M07-AC-06 | [M07](modules/M07-automated-test-generation.md) | The generation/exploration container has no repository write credential. Inspecting its environment and filesystem during a test shows no token. | Security | P9 | BR-01, BR-02 |
| M07-AC-07 | [M07](modules/M07-automated-test-generation.md) | A hand-written test with an `@tc:` tag binds without any AI involvement. | Integration | P6 | BR-01, BR-02 |
| M08-AC-01 | [M08](modules/M08-test-execution-center.md) | A manual run of the demo smoke suite executes in a sandbox container running as non-root with read-only rootfs, and produces results, screenshots, and traces viewable… | Security | P6 | BR-01, BR-03 |
| M08-AC-02 | [M08](modules/M08-test-execution-center.md) | A test failing on attempt 1 and passing on attempt 2 is reported `flaky`, both attempts visible, and counted per policy in the gate. | Integration | P6 | BR-01, BR-03 |
| M08-AC-03 | [M08](modules/M08-test-execution-center.md) | Killing the execution-controller process mid-run results, after restart, in either resumed observation or `interrupted` → re-queued run, never a run stuck in `running`. | Resilience | P6 | BR-01, BR-03 |
| M08-AC-04 | [M08](modules/M08-test-execution-center.md) | Submitting the same run request twice with the same Idempotency-Key creates exactly one run. | Integration | P6 | BR-01, BR-03 |
| M08-AC-05 | [M08](modules/M08-test-execution-center.md) | A sandboxed test attempting to reach a host not in the environment allowlist fails with a network error logged as `egress_denied`. | Security | P6 | BR-01, BR-03 |
| M08-AC-06 | [M08](modules/M08-test-execution-center.md) | A sandboxed test cannot read host files or reach the Docker socket or the QualityOS DB (security test suite). | Security | P6 | BR-01, BR-03 |
| M08-AC-07 | [M08](modules/M08-test-execution-center.md) | Cancelling a running run stops containers within 30 s and finalizes as `cancelled` with partial results retained. | Integration | P6 | BR-01, BR-03 |
| M08-AC-08 | [M08](modules/M08-test-execution-center.md) | A finalized run's results cannot be modified via any API; reclassification creates annotations only. | Integration | P6 | BR-01, BR-03 |
| M08-AC-09 | [M08](modules/M08-test-execution-center.md) | Quality gate "smoke 100% and 0 new product defects ≥ high" evaluates correctly for pass and fail fixtures and its reasons list matches. | Integration | P8 | BR-01, BR-03 |
| M08-AC-10 | [M08](modules/M08-test-execution-center.md) | Results posted by a CI-delegated backend through the Automation API produce the same canonical result model as local runs (contract test). | Contract | P6 | BR-01, BR-03 |
| M09-AC-01 | [M09](modules/M09-visual-regression.md) | First run of a new checkpoint creates a candidate baseline that is not used for pass/fail until approved. | Integration | P9 | BR-03, BR-14 |
| M09-AC-02 | [M09](modules/M09-visual-regression.md) | A deliberate CSS change in the demo app produces a diff shown in side-by-side, slider, and heatmap modes. | E2E (Playwright, demo mode) | P9 | BR-03, BR-14 |
| M09-AC-03 | [M09](modules/M09-visual-regression.md) | Approving a diff creates baseline version n+1 attributed to the approver; the next run passes. | Integration | P9 | BR-03, BR-14 |
| M09-AC-04 | [M09](modules/M09-visual-regression.md) | No API path other than review approval can create or modify baselines (API test enumerating endpoints + AI fix proposal guard test). | Integration | P9 | BR-03, BR-14 |
| M09-AC-05 | [M09](modules/M09-visual-regression.md) | An Arabic RTL page variant is captured and compared separately from the LTR variant. | Integration | P9 | BR-03, BR-14 |
| M09-AC-06 | [M09](modules/M09-visual-regression.md) | A masked dynamic region does not cause diffs when its content changes. | Integration | P9 | BR-03, BR-14 |
| M09-AC-07 | [M09](modules/M09-visual-regression.md) | Changing the Playwright image major version marks baselines `needs_rebaseline`. | Integration | P9 | BR-03, BR-14 |
| M10-AC-01 | [M10](modules/M10-defect-intelligence.md) | A failed automated test produces a failure analysis with a deterministic signal summary, a classification, a confidence, and a rationale referencing at least one evide… | Integration | P8 | BR-05, BR-09 |
| M10-AC-02 | [M10](modules/M10-defect-intelligence.md) | 10 failures with the same error signature in one run form a single cluster and a single draft. | Integration | P8 | BR-05, BR-09 |
| M10-AC-03 | [M10](modules/M10-defect-intelligence.md) | With the default policy, no external issue is created without a human approval event recorded in the audit. | Integration | P8 | BR-05, BR-09 |
| M10-AC-04 | [M10](modules/M10-defect-intelligence.md) | Simulating a timeout after the tracker created the issue results in exactly one external issue after retry (marker search). | Integration | P8 | BR-05, BR-09 |
| M10-AC-05 | [M10](modules/M10-defect-intelligence.md) | An approved draft creates an Azure Boards work item (mock/recorded) with mapped type, state, severity, and an ExternalRef stored and displayed. | Integration | P8 | BR-05, BR-09 |
| M10-AC-06 | [M10](modules/M10-defect-intelligence.md) | Commit "Fixes PRJ-D-7" on the default branch moves the defect to `fix_candidate` and creates a retest. A passing retest marks it `verified`, and a flaky pass marks it… | Integration | P8 | BR-05, BR-09 |
| M10-AC-07 | [M10](modules/M10-defect-intelligence.md) | External state "Closed" while internal verification failed raises a sync conflict and does not mark the defect verified. | Integration | P8 | BR-05, BR-09 |
| M10-AC-08 | [M10](modules/M10-defect-intelligence.md) | Overriding an AI classification stores an annotation, and the original immutable result is unchanged. | Integration | P4 / P8 | BR-05, BR-09 |
| M10-AC-09 | [M10](modules/M10-defect-intelligence.md) | Switching the project tracker from Azure Boards to the internal tracker keeps the external links of existing defects, and new defects are internal. | Integration | P8 | BR-05, BR-09 |
| M11-AC-01 | [M11](modules/M11-automation-center.md) | Two concurrent `fire` calls for the same rule and slot produce exactly one firing and one test run. The second returns `alreadyFired`. | Resilience | P7 | BR-01, BR-03 |
| M11-AC-02 | [M11](modules/M11-automation-center.md) | With n8n stopped, the nightly regression rule (O-F) still creates its test run within grace + 1 min, tagged `core_fallback`, and an in-app notification is created. | Resilience | P7 | BR-01, BR-03 |
| M11-AC-03 | [M11](modules/M11-automation-center.md) | With n8n stopped, a Class O notification rule does not fall back. Its dispatch is queued and delivered after n8n restarts. | Resilience | P7 | BR-01, BR-03 |
| M11-AC-04 | [M11](modules/M11-automation-center.md) | Restarting n8n mid-workflow leads to a timed-out automation run that is retried, with no duplicate side effects (verified by counting created runs and notifications). | Resilience | P7 | BR-01, BR-03 |
| M11-AC-05 | [M11](modules/M11-automation-center.md) | A laptop "sleep" simulation (core stopped across 3 slots) with `latest_only` produces exactly one catch-up firing on resume. | Resilience | P7 | BR-01, BR-03 |
| M11-AC-06 | [M11](modules/M11-automation-center.md) | A dispatch with an invalid HMAC is rejected by the n8n template's verification node (workflow template test). | Security | P7 | BR-01, BR-03 |
| M11-AC-07 | [M11](modules/M11-automation-center.md) | The rule dry-run shows actions without creating any run, notification, or firing record. | E2E (Playwright, demo mode) | P7 | BR-01, BR-03 |
| M11-AC-08 | [M11](modules/M11-automation-center.md) | The workflow template drift detector flags a template modified in n8n's UI. | E2E (Playwright, demo mode) | P7 | BR-01, BR-03 |
| M12-AC-01 | [M12](modules/M12-reports-analytics.md) | Every KPI in [29](29-business-case-and-kpis.md) exists in the registry, and its computed value on the seeded dataset equals an independently computed SQL fixture. | Integration | P10 | BR-08, BR-12 |
| M12-AC-02 | [M12](modules/M12-reports-analytics.md) | The executive summary separates measured and estimated sections, and the estimated section lists its assumptions. | Integration | P10 | BR-08, BR-12 |
| M12-AC-03 | [M12](modules/M12-reports-analytics.md) | An AI narrative containing a number not in the input is rejected, and the report renders without a narrative plus a notice. | Integration | P10 | BR-08, BR-12 |
| M12-AC-04 | [M12](modules/M12-reports-analytics.md) | After a run is finalized, the project metrics reflect it within 2 minutes. | Integration | P10 | BR-08, BR-12 |
| M12-AC-05 | [M12](modules/M12-reports-analytics.md) | A report generated for a user lacking access to project B contains no data from B. | Integration | P10 | BR-08, BR-12 |
| M12-AC-06 | [M12](modules/M12-reports-analytics.md) | The cost report totals equal the sum of AI ledger entries plus compute plus storage estimates for the period. | Integration | P10 | BR-08, BR-12 |
| M13-AC-01 | [M13](modules/M13-team-permissions.md) | An automated test enumerates every API route and asserts each declares a permission; missing declarations fail CI. | Integration (generated) | P2 | BR-07 |
| M13-AC-02 | [M13](modules/M13-team-permissions.md) | A `qa_engineer` in project A gets 404 for any resource in project B. Resource existence is not leaked. | Integration | P2 | BR-07 |
| M13-AC-03 | [M13](modules/M13-team-permissions.md) | Deactivating a user invalidates their active sessions and tokens within 1 s, and the next request returns 401. | Integration | P2 | BR-07 |
| M13-AC-04 | [M13](modules/M13-team-permissions.md) | A `qa_lead` cannot assign `org_admin` or change their own role. | Integration | P2 | BR-07 |
| M13-AC-05 | [M13](modules/M13-team-permissions.md) | A token without scope `automation:fire` receives 403 on `/automation/v1/rules/{id}/fire`. | Security | P2 | BR-07 |
| M13-AC-06 | [M13](modules/M13-team-permissions.md) | The permission matrix in this document matches the seeded role-permission data (generated-doc test). | Integration (generated) | P2 | BR-07 |
| M14-AC-01 | [M14](modules/M14-security-audit-settings.md) | Attempting UPDATE/DELETE on `audit_events` with the application DB role fails (DB permission test). | Security | P2 | BR-09, BR-12, BR-13 |
| M14-AC-02 | [M14](modules/M14-security-audit-settings.md) | The audit hash chain verification detects a tampered record in a test database. | Security | P11 | BR-09, BR-12, BR-13 |
| M14-AC-03 | [M14](modules/M14-security-audit-settings.md) | A draft author cannot approve their own draft under the default policy, and the self-approval override works only in single-approver projects and is flagged. | Integration | P2 | BR-09, BR-12, BR-13 |
| M14-AC-04 | [M14](modules/M14-security-audit-settings.md) | Editing a draft after approval was requested invalidates the pending approval. | Integration | P2 | BR-09, BR-12, BR-13 |
| M14-AC-05 | [M14](modules/M14-security-audit-settings.md) | An AI task whose estimated cost exceeds the remaining budget is rejected before any provider call (mock provider receives 0 requests). | Integration | P5 | BR-09, BR-12, BR-13 |
| M14-AC-06 | [M14](modules/M14-security-audit-settings.md) | Restore verification restores the latest backup to a scratch DB and reports row counts and integrity checks. A corrupted backup is detected. | Integration | P11 | BR-09, BR-12, BR-13 |
| M14-AC-07 | [M14](modules/M14-security-audit-settings.md) | Secrets never appear in logs during the full E2E suite (log scan for known secret values). | Security | P2 | BR-09, BR-12, BR-13 |
| M14-AC-08 | [M14](modules/M14-security-audit-settings.md) | Retention purges expired videos but not those under legal hold, and writes an aggregate audit event. | Integration | P11 | BR-09, BR-12, BR-13 |

## 2. Cross-cutting acceptance criteria
| AC | Criterion | Primary verification | Phase | Source |
|---|---|---|---|---|
| X-AC-01 | Every API route declares a permission; foreign-project access returns 404 on every route | Integration (generated) | P2 | FR-X-01, M13 |
| X-AC-02 | Every state-changing action writes an audit event with correlation id | Integration | P2 | FR-X-02 |
| X-AC-03 | Every write endpoint honours Idempotency-Key; automation API rejects requests without it | Contract | P1/P7 | FR-X-08 |
| X-AC-04 | AI-produced content is badged and links to its AI execution record | E2E | P5 | FR-X-04 |
| X-AC-05 | External mutations occur only after policy approval and are audited with external refs | Integration | P8 | FR-X-05 |
| X-AC-06 | Full E2E suite passes in demo mode without any external credentials | E2E | every phase from P2 | FR-X-15 |
| X-AC-07 | Every KPI tile/value shows formula + provenance; values match KPI fixture computations | E2E + Integration | P10 | FR-X-16, [29](29-business-case-and-kpis.md) |
| X-AC-08 | Core screens pass axe-core (no serious/critical) in LTR and RTL, light and dark | Accessibility + Visual | P1→P10 | NFR-UX-01/03/04 |
| X-AC-09 | No secret values or token patterns in logs/responses across the full E2E run | Security | P2→ | NFR-SEC-03 |
| X-AC-10 | No run remains in a non-terminal state beyond timeout + 5 min after any injected failure | Resilience | P6/P11 | NFR-REL-04 |
| X-AC-11 | Provider contract suites pass for every registered adapter (mock + recorded) | Contract | P2→ | [12 §5](12-provider-contracts.md) |
| X-AC-12 | Mixed-provider projects (GitHub+PDF+Azure; GitLab+Azure+Internal) operate simultaneously and independently | E2E | P8 (mocks), P13 (real) | [33 §7](33-provider-compatibility-matrix.md) |

## 3. Workflow acceptance (end-to-end)
| Workflow | Covered by ACs | E2E scenario |
|---|---|---|
| WF-A Requirement → Test | M04-AC-01/03/09, M05-AC-01, M07-AC-01/04, M08-AC-01 | `e2e/wf-a.spec.ts` |
| WF-B Code change → QA | M08-AC-04, M11-AC-01/02 | `e2e/wf-b.spec.ts` |
| WF-C Failure → Bug | M10-AC-01…05 | `e2e/wf-c.spec.ts` |
| WF-D Fix verification | M10-AC-06/07, M06-AC-06 | `e2e/wf-d.spec.ts` |
| WF-E Document change | M04-AC-04, M05-AC-04 | `e2e/wf-e.spec.ts` |
| WF-F Provider switch | M02-AC-04, M03-AC-05, M10-AC-09 | `e2e/wf-f.spec.ts` |
| WF-G Orchestrator outage | M11-AC-01/02/05 | `resilience/wf-g.spec.ts` |
| WF-H Manual cycle | M06-AC-01…07 | `e2e/wf-h.spec.ts` |

## 4. Business requirement coverage
| BR | Covered by (modules) |
|---|---|
| BR-01 | M07, M08, M11 |
| BR-02 | M05, M07 |
| BR-03 | M08, M09, M11 |
| BR-04 | M05 |
| BR-05 | M06, M10 |
| BR-06 | M04, M06 |
| BR-07 | M02, M13 |
| BR-08 | M01, M12 |
| BR-09 | M05, M10, M14 |
| BR-10 | M02, M03 (+ X-AC-11/12) |
| BR-11 | [23](23-local-deployment.md), [28](28-enterprise-rollout.md) (migration rehearsal T-P13-20) |
| BR-12 | M12, M14 |
| BR-13 | M14 (+ pilot checklist [27 §3](27-pilot-validation-plan.md)) |
| BR-14 | M04, M09 (+ X-AC-08) |
