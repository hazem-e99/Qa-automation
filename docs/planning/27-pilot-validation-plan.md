# 27 — Personal Pilot Validation Plan

> Status: **Planned** (phase P12) · Owner: the owner (acting as QA Lead, Automation Engineer, and Platform Admin) · KPIs: [29](29-business-case-and-kpis.md)

## 1. Purpose
Validate QualityOS on the owner's personal projects for **4–6 weeks**, using pre-registered success and failure criteria, so that any later company proposal rests on measured evidence.

## 2. Pilot project selection
Choose **2–3 personal projects** that together cover:
- a web application with a UI (needed for Playwright, visual, and RTL)
- at least one project with an **Arabic UI or Arabic requirements documents**
- requirements held in **Azure Boards** (personal organization), plus at least one **PDF/DOCX spec**
- code on **GitHub**
- at least ~30 requirements and ~80 test cases in total, so the KPIs have enough samples
- a deployable dev or staging environment reachable from the machine

Record the selection in a pilot charter (T-P12-01): project, stack, environments, and the data safety statement (no company data).

## 3. Pilot readiness checklist (gate from P11)
- [ ] `v0.9-pilot` tagged. CI green. Security suites green, or every finding triaged.
- [ ] Backup and restore verified in the last 7 days.
- [ ] Integrations healthy: GitHub (fine-grained PAT), Azure DevOps (org-scoped PAT, expiry ≥ 60 days), Claude key, n8n templates imported.
- [ ] AI budget set (default USD 50/month) with alerts at 80%.
- [ ] Retention set. Disk space ≥ 50 GB free.
- [ ] Approval policies set for a single-person team: `allowSelfApproval=true` on pilot projects. This is permitted only because each project has one member with an approver role, and every self-approval is flagged in the audit (BR-M14-2). The pilot report counts these approvals, and this setting **must be turned off** for any multi-person deployment.
- [ ] Weekly review template ready, and the baseline measurement sheet prepared.
- [ ] Every pilot credential is personal. No company resources (AS-04).

## 4. Baseline measurement (week 0, before QualityOS is used for these projects)
Do one regression pass the "old way" (spreadsheet or notes, manual execution, manual bug write-ups) for each pilot project, and measure:

| Baseline metric | How |
|---|---|
| Manual minutes per test case execution | Stopwatch / timer app for ≥ 30 executions |
| Bug report preparation time | Time from noticing a failure to a filed Azure Boards item, ≥ 5 bugs (seeded bugs in demo-like branches are acceptable) |
| Regression frequency | Runs per week over the previous month (recall/estimate, labelled estimate) |
| Requirement coverage (approx.) | Manual mapping of existing tests to requirements |
| Test design time | Minutes to write test cases for 5 requirements manually |

## 5. Pilot operation (weeks 1–5/6)
| Week | Focus | Workflow coverage |
|---|---|---|
| 1 | Requirements ingestion (Azure + PDF), review, approval. Manual test design with AI suggestions | WF-A (to approved tests), J2, J3 |
| 2 | Manual cycles on QualityOS. Defect drafts. Azure Boards sync | J4, WF-C (manual), WF-H |
| 3 | Automation: codegen PRs for ~15 cases. Nightly regression rule. Visual baselines | J5, WF-A (full), WF-G, M09 |
| 4 | Failure triage. Fix verification. Requirement document v2 change | J6, J7, WF-C, WF-D, WF-E |
| 5 | Stability week: no new features, steady operation, resilience drills (stop n8n, reboot) | WF-G resilience, recovery |
| 6 (optional) | Provider switch drill: GitHub → Local Git mirror, or tracker Azure → Internal for a test project | WF-F |

**Weekly review** (T-P12-07), 30–45 minutes, written up in `docs/pilot/week-N.md`:
1. KPI snapshot (auto-exported): KPI-01, 02, 03, 07, 08, 12, 14, 16, 18, 20, 24, 25.
2. Time log: hours spent on test design, execution, triage, maintenance, and platform admin (self-reported).
3. AI accuracy log: rejected suggestions by reason, classification overrides, duplicate errors, grounding failures.
4. False positives: automated failures that were not product defects, by cause.
5. Integration incidents: sync failures, webhook issues, n8n issues, fallback activations.
6. UX friction notes: top 3 annoyances and top 3 delights.
7. Cost: AI spend to date versus budget.
8. Decisions and changes made: config, prompts, policies.

## 6. Success and failure criteria (pre-registered)
**Success** requires all **must** criteria and at least 3 **should** criteria.

| # | Criterion | Threshold | Type |
|---|---|---|---|
| S1 | Functional completeness | All WF-A…WF-E executed end-to-end at least once on real pilot data | must |
| S2 | Reliability | No data loss. No run stuck > timeout + 5 min. Integration reliability KPI-24 ≥ 98%. Every resilience drill recovers per spec | must |
| S3 | Trustworthy results | Automated false-positive rate KPI-14 ≤ 15% by week 5, with a downward trend. Every failure has evidence attached | must |
| S4 | Safety | Zero unauthorized external writes (audit check). Zero secrets in logs (scan). No guard bypass in codegen | must |
| S5 | Bug report time | Median KPI-12 ≤ 50% of the baseline | should |
| S6 | Regression frequency | KPI-25 ≥ 3× baseline (nightly automation) | should |
| S7 | Coverage | KPI-02 ≥ 80% on pilot projects; KPI-03 ≥ 30% | should |
| S8 | AI usefulness | KPI-20 (tests.suggest) ≥ 60%; failure classification product-defect precision ≥ 0.85 on pilot data | should |
| S9 | Cost | AI spend ≤ budget; KPI-18 shows cost per accepted test case ≤ a self-set ceiling (e.g. USD 0.25) | should |
| S10 | Effort balance | Net hours (KPI-22 minus maintenance/triage/admin) positive by week 5 (estimate, labelled) | should |

**Failure / stop criteria:** any one of these pauses the pilot for a root-cause review.
- Any data-loss incident, or any unauthorized external write.
- KPI-14 > 30% in two consecutive weeks.
- Maintenance plus triage time exceeds the manual execution time it replaced for 3 consecutive weeks.
- Critical security finding.

## 7. AI output accuracy evaluation in the pilot
- Every suggestion disposition is recorded automatically (KPI-20 by reason).
- **Weekly sample audit:** 10 random accepted test cases are checked for correctness against requirements, and 10 random classifications are re-checked by hand. Each sample gets a precision estimate with a confidence interval (Wilson), reported with sample size.
- **Grounding failures and validator drops are counted.** The expected value is zero grounding failures reaching the user.

## 8. Pilot report (T-P12-10) structure
1. Executive summary with a go / conditional-go / no-go recommendation.
2. Baseline vs pilot KPI table. Measured and estimated values are kept in separate sections.
3. Success criteria scorecard (S1–S10).
4. Reliability and incidents log.
5. AI accuracy findings and prompt changes made.
6. Cost summary (AI, compute time, storage growth).
7. UX feedback and the backlog of improvements.
8. Readiness gaps for company rollout, mapped to [28 §2](28-enterprise-rollout.md).
9. An appendix of raw weekly notes and data exports.

## 9. Ethics and data safety
- Only personal and synthetic data.
- No real users' personal data in test environments.
- AI receives redacted content only.
- The pilot report contains no secrets and no third-party confidential information.
