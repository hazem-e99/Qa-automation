# 04 — Personas and User Journeys

> Status: **Planned** · Owner: Product Manager + UX Designer · Last reviewed: 2026-11-09

Personas describe *people*. Roles describe *permissions* ([M13](modules/M13-team-permissions.md)). One person can hold different roles in different projects.

## 1. Personas

| Persona | Typical role(s) | Goals | Pain today | What QualityOS must do for them |
|---|---|---|---|---|
| **Layla — QA Lead** | `qa_lead` | Plan test cycles, assure coverage, report status, keep the team consistent | Coverage lives in spreadsheets; status reports take hours; design quality varies | Coverage and traceability at a glance; approval queues; one-click cycle reports; project templates and policies |
| **Omar — Manual QA Engineer** | `qa_engineer` | Execute tests quickly, log clear bugs, retest fixes | Repetitive regression; bug reports take 20–40 min each (hypothesis, to be measured); steps scattered across documents | Fast step-by-step runner with keyboard shortcuts, evidence capture, a bug draft generated from a failed step, a retest queue |
| **Sara — Automation Engineer** | `qa_engineer` (+ repo write) | Grow stable automation, keep flakiness low | Writing boilerplate; flaky tests; mapping tests back to requirements | AI-generated test code reviewed in PRs, stable tags/bindings, flaky-test dashboard, traces in the run viewer |
| **Khaled — QC Reviewer** | `qc_reviewer` | Verify that tests and defects meet standards before release | Inconsistent reports, evidence missing | Review queues with checklists, evidence completeness indicators, audit trail |
| **Dina — Developer** | `developer` | Understand failures quickly, reproduce bugs, confirm fixes | Vague bug reports; can't find test evidence | Reproducible bug reports with trace, video and steps; links from the external issue back to QualityOS evidence; fix-verification status |
| **Hany — Project Manager** | `project_manager` | Release-readiness decisions | No reliable quality signal | Quality gate status per build, risk indicators, explained metrics |
| **Executive stakeholder** | `viewer` (org-wide) | Portfolio quality trends, ROI | No data | Company dashboard with defined KPIs, measured vs estimated clearly marked |
| **Platform Admin (the owner in the pilot)** | `platform_admin` | Install, configure, secure, keep healthy | n/a | Health dashboard, integration diagnostics, backups, audit |

## 2. Core user journeys

Each journey lists its steps and the main screens involved (screen IDs are in [20 §4](20-ui-ux-architecture.md)). The system-level flows are in [19](19-workflow-specifications.md).

### J1 — First-time setup (Platform Admin), 20–30 min
1. Runs `docker compose up` and opens QualityOS. The first-run wizard (`S-ONB-01`) creates the admin account and organization.
2. Chooses **Demo mode** (seeded sample project with mock providers) or **Real setup**.
3. In the Integration Hub (`S-INT-01`), connects GitHub with a fine-grained PAT, then Azure DevOps with an org-scoped PAT, then the Claude API key. Each connection runs *Test connection* and shows its discovered capabilities and missing permissions.
4. Creates a project with the wizard (`S-PRJ-02`): name and key → application repository → test repository mode → requirements sources → issue tracker → CI (optional) → AI configuration → environments → members. The final step is an **integration health check**.
5. **Success:** the project overview (`S-PRJ-01`) shows all bindings green and the first requirements sync running.

### J2 — Requirements from mixed sources (QA Lead), the core differentiator
1. Opens Requirements (`S-REQ-01`). The Azure Boards sync has imported 40 user stories, and a PDF spec has been uploaded.
2. The extraction review (`S-REQ-03`) shows the PDF on the left and the extracted candidates on the right. Each candidate shows its page locator and confidence. Low-confidence and inferred items are highlighted.
3. The analysis panel lists:
   - **Conflicts**, e.g. a story says "password ≥ 8 chars" while the PDF says "≥ 12".
   - **Gaps**, e.g. no error behavior defined for a locked account.
   - **Duplicates** across sources.
4. Layla resolves the conflicts by choosing the authoritative source, edits the candidates, and **approves** them. Each approval creates an immutable RequirementVersion.
5. **Success:** coverage shows 52 approved requirements, 0 covered, and suggests "Generate test suggestions".

### J3 — AI-assisted test design (QA Engineer)
1. In the AI Test Studio (`S-TST-03`), Omar selects 10 approved requirements and asks for test suggestions with the types happy, negative, boundary, and accessibility.
2. The AI returns structured test cases, each with requirement references. Every suggestion shows *why* (which acceptance criterion it covers) and the coverage gaps it closes.
3. For each suggestion Omar chooses **Accept**, **Edit and accept**, or **Reject (with a reason)**. A QC reviewer approval is needed when the project policy says so.
4. **Success:** the accepted test cases are in suite "Login – Regression", linked to their requirements, with automation status `candidate`.

### J4 — Manual test cycle (QA Engineer)
1. Layla creates cycle "Release 1.4 – Regression" against environment `staging` and build `1.4.0-rc1`, and assigns cases.
2. Omar opens his queue (`S-MAN-01`) and runs a case in the step runner (`S-MAN-02`). He marks each step pass, fail, or blocked with the keyboard (`P`/`F`/`B`) and pastes screenshots.
3. A step fails. He clicks **Create defect**. A draft opens, prefilled with the steps up to the failure, the expected and actual results, the environment, the build, and the evidence. AI can tidy up the wording.
4. The defect follows the approval policy, for example "QA Lead approves before it is pushed to Azure Boards". Once approved, it is created in Azure Boards, and the external ID and link are stored.
5. **Success:** the cycle progress updates, and the defect is traceable from requirement to test to execution to defect.

### J5 — Automate an approved test (Automation Engineer)
1. Sara filters the test cases with `automation_status = candidate` and clicks **Generate automation** for 5 of them.
2. QualityOS runs the code-generation task in a sandbox against the test repository. It follows `CONVENTIONS.md` and uses the Playwright planner and generator where enabled, then opens PR `qos/gen/TC-101-105` with a summary of assertions mapped to expected results.
3. Sara reviews the PR in GitHub. CI runs. She merges.
4. Polling detects the merge, and the automation bindings (by `@tc:` tags) are activated. Those test cases become `automated`.
5. **Success:** the next nightly regression includes them.

### J6 — Nightly regression and failure triage (Automation Engineer and QA Lead)
1. The n8n schedule claims tonight's slot and creates the run. If n8n is down, the core fallback creates it after the grace period.
2. The run executes in sandbox containers. One test fails on its first attempt and passes on retry, so it is marked **flaky**, not passed. Another test fails twice.
3. The failure analysis (`S-EXE-04`) classifies the second failure as `product_defect` with a rationale and evidence links: trace step, console error, network 500. It finds a possible duplicate of an existing defect at 0.82 similarity and shows it side by side.
4. Layla confirms "not a duplicate" and approves the defect draft. It is pushed to Azure Boards.
5. **Success:** the morning dashboard shows the run summary, the new defect, the flaky test list, and the quality gate result.

### J7 — Fix verification (Developer and QA)
1. Dina's commit message references the defect (`Fixes QOS-D-77`, or the external ID `AB#1234`). Polling detects the commit on the default branch.
2. QualityOS marks the defect `fix_candidate` and schedules a retest of the linked tests on the next deployment event or a manual trigger.
3. The retest passes, so verification is `verified`. Under policy, the external issue gets a comment, and its state changes to Resolved only if the policy allows it.
4. **Success:** the traceability chain closes. Time to verify is recorded (KPI-23).

### J8 — Requirements document changes (QA Lead)
1. A new version of the PDF spec is uploaded.
2. The diff view (`S-REQ-04`) shows requirements that were added, changed, or removed, and the affected test cases, found through traceability links.
3. AI proposes test case updates. Layla accepts some, and affected tests are flagged `needs_review` until a decision is made.
4. **Success:** no approved test silently points to an outdated requirement version.

### J9 — Switching providers (Platform Admin)
1. A project moves from GitHub to GitLab. The admin adds a GitLab connection, maps the old repository to the new one, and validates permissions.
2. The new binding is activated. The old connection becomes `retired` and stays read-only for its history. Historical commits and PR links still show their stored snapshots.
3. **Success:** new runs use GitLab, and the audit history is intact ([19 WF-F](19-workflow-specifications.md)).

### J10 — Release readiness (Project Manager)
1. Hany opens the project's Release view and sees the quality gate for `1.4.0-rc2`: smoke 100%, regression 97.8%, 0 open critical defects, requirement coverage 86%.
2. Every number expands into its formula and data ([29](29-business-case-and-kpis.md)).
3. **Success:** a release decision is made from explained data. Hany can export a report.

## 3. Journey-to-module matrix
| Journey | M01 | M02 | M03 | M04 | M05 | M06 | M07 | M08 | M09 | M10 | M11 | M12 | M13 | M14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| J1 | | ● | ● | | | | | | | | | | ● | ● |
| J2 | | | ● | ● | | | | | | | | | | |
| J3 | | | | ● | ● | | | | | | | | | ● |
| J4 | | | | | ● | ● | | | | ● | | | | ● |
| J5 | | | ● | | ● | | ● | ● | | | | | | |
| J6 | ● | | | | | | | ● | ● | ● | ● | | | ● |
| J7 | | | ● | | | | | ● | | ● | ● | | | |
| J8 | | | | ● | ● | | | | | | ● | | | |
| J9 | | ● | ● | | | | | | | | | | | ● |
| J10 | ● | | | | | | | | | | | ● | | |
