# 05 — Functional Requirements (Index and Cross-Cutting)

> Status: **Planned** · Owner: Product Manager · Last reviewed: 2026-11-09

Module-specific functional requirements are in the module specifications. Each one has an ID of the form `Mxx-FR-nn`. This document holds the **module index**, the **module spec template**, and the **cross-cutting functional requirements** (`FR-X-nn`) that apply to every module.

## 1. Module index

| ID | Module | Primary phase(s) | Spec |
|---|---|---|---|
| M01 | Company Dashboard | P10 (skeleton P4) | [M01](modules/M01-company-dashboard.md) |
| M02 | Project Management | P2 | [M02](modules/M02-project-management.md) |
| M03 | Integration Hub | P2 (+ adapters in P3, P8, P13) | [M03](modules/M03-integration-hub.md) |
| M04 | Requirements Intelligence Center | P3 (AI analysis P5) | [M04](modules/M04-requirements-intelligence.md) |
| M05 | AI Test Studio | P4 (manual authoring), P5 (AI) | [M05](modules/M05-ai-test-studio.md) |
| M06 | Manual Testing Workspace | P4 | [M06](modules/M06-manual-testing-workspace.md) |
| M07 | Automated Test Generation | P9 | [M07](modules/M07-automated-test-generation.md) |
| M08 | Test Execution Center | P6 | [M08](modules/M08-test-execution-center.md) |
| M09 | Visual Regression Testing | P9 | [M09](modules/M09-visual-regression.md) |
| M10 | AI Defect Intelligence | P4 (internal defects), P8 (AI + sync) | [M10](modules/M10-defect-intelligence.md) |
| M11 | Automation Center | P7 | [M11](modules/M11-automation-center.md) |
| M12 | Reports and Analytics | P10 | [M12](modules/M12-reports-analytics.md) |
| M13 | Team and Permissions | P2 (base), P11 (advanced) | [M13](modules/M13-team-permissions.md) |
| M14 | Security, Audit and Settings | P2 (audit/secrets), P11 | [M14](modules/M14-security-audit-settings.md) |

## 2. Module spec template (mandatory sections)
Every module spec has these 18 sections, in this order:
1. Purpose & responsibilities
2. Roles
3. Features (`Mxx-FR-nn`)
4. User journeys
5. UI screens
6. Domain entities
7. API endpoints
8. Business rules
9. Permissions
10. Provider dependencies
11. Events & workflow integration
12. Security requirements
13. Failure scenarios & error handling
14. Edge cases
15. Acceptance criteria (`Mxx-AC-nn`)
16. Implementation tasks
17. Testing requirements
18. Dependencies & technical risks

## 3. Cross-cutting functional requirements

| ID | Requirement | Applies to | Verified by |
|---|---|---|---|
| FR-X-01 | Every domain record except users and organization settings belongs to exactly one project. Every read and write is authorized against the caller's project membership. | All | Isolation test suite ([24 §9](24-testing-strategy.md)) |
| FR-X-02 | Every state-changing action writes an **audit event** with actor, action, target, before/after diff summary, correlation ID, and source (UI, API token, automation, or system). | All | Audit contract tests |
| FR-X-03 | Every list view supports server-side pagination (cursor-based), sorting, filtering, and saved views. | UI/API | API contract tests |
| FR-X-04 | Every AI-produced artifact is labelled as such in the UI with an "AI" badge and a link to the AI execution record (task, model, prompt version, cost). It stays a suggestion until approved. | M04, M05, M07, M10, M12 | UI tests + AC in modules |
| FR-X-05 | Any action that changes an **external system** (create issue, comment, open PR, change issue state) goes through the Approval Policy Engine and is recorded with its outcome and external reference. | M03, M07, M10 | Policy engine tests |
| FR-X-06 | Every external object shown in QualityOS displays its source provider, a deep link, the last sync time, and a stale indicator when sync is overdue. | M03, M04, M10 | UI tests |
| FR-X-07 | Every long-running operation (sync, parse, AI task, run) is asynchronous. It returns an operation ID, reports progress, and can be cancelled where the operation supports it. | All | API tests |
| FR-X-08 | All write APIs accept an `Idempotency-Key` header. It is **required** for automation API endpoints and service tokens. | API | Contract tests |
| FR-X-09 | Every user-facing date is shown in the user's timezone and stored in UTC. Every user-facing string is externalized for i18n. Layouts work in RTL. | UI | i18n lint, RTL visual tests |
| FR-X-10 | Every module has empty, loading, error, and permission-denied states ([20 §8](20-ui-ux-architecture.md)). | UI | Storybook + visual tests |
| FR-X-11 | Global search (`Ctrl/⌘+K`) finds requirements, test cases, runs, and defects by key, title, and external ID within the user's accessible projects. | UI/API | E2E |
| FR-X-12 | Every entity has a human-readable key per project: `{PROJECTKEY}-R-12` (requirement), `-TC-34` (test case), `-RUN-56` (run), `-D-78` (defect). Keys are never reused. | Domain | Unit tests |
| FR-X-13 | Comments with @mentions on requirements, test cases, runs, and defects. Mentions create notifications. | M04–M10 | E2E |
| FR-X-14 | Export to CSV and JSON on every list, and to PDF for reports. Exports respect permissions and are audited. | UI/API | E2E |
| FR-X-15 | Demo mode: the whole product works with mock adapters and seed data, with no external credentials. | All | CI runs the E2E suite in demo mode |
| FR-X-16 | Every metric shown carries its definition (tooltip linking to its formula) and a provenance tag: `measured`, `derived`, or `estimated`. | M01, M12 | UI tests |

## 4. Priority classification
- **Must (pilot):** M02, M03, M04, M05, M06, M08, M10 (incl. Azure Boards sync), M11, M13 (base), M14 (audit, secrets, budgets), M01 (basic), M12 (core KPIs).
- **Should (pilot):** M07, M09, AI analysis in M04, duplicate detection in M10.
- **Could (post-pilot):** advanced dashboard comparisons, custom report builder, SSO, multi-org.
