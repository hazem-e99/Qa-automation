# 29 — Business Case and KPIs

> Status: **Planned** · Owner: Product Manager · Principle: **measured, not assumed.** We claim no fixed automation percentage or guaranteed savings.

## 1. Provenance labels
| Label | Meaning | Example |
|---|---|---|
| **measured** | Computed directly from QualityOS records | pass rate, coverage |
| **derived** | Computed from measured data plus a configured, published rate | AI cost (tokens × price table) |
| **estimated** | Depends on assumptions a human supplied | time saved, ROI |
Every KPI value in the UI and in reports carries one of these labels (FR-X-16).

## 2. KPI conventions
- **Time window:** configurable, 30 days by default.
- **Environment:** the reference environment set in the project's quality settings (e.g. `staging`).
- **Final status:** per execution, after retries ([09 §3.3](09-domain-model.md)).
- **First-attempt status:** the outcome of attempt 1.
- **Minimum sample:** below the minimum, the value shows as "insufficient data".

## 3. KPI catalog (exact formulas)
| ID | KPI | Formula | Unit | Provenance | Min sample |
|---|---|---|---|---|---|
| KPI-01 | First-attempt pass rate | `count(executions where attempt1.status = passed) / count(executions where final_status ∈ {passed, failed, flaky})` over automated runs in window | % | measured | 20 executions |
| KPI-02 | Requirement coverage | `count(effective approved requirements with ≥1 active verifies link to an approved test case version) / count(effective approved requirements)` at period end | % | measured | 10 requirements |
| KPI-03 | Automated requirement coverage | Same as KPI-02, but the linked test case must have `automation_status = automated` (active binding) | % | measured | 10 |
| KPI-04 | Executed requirement coverage | `count(approved requirements whose linked tests had ≥1 final result on reference env in window) / count(approved requirements)` | % | measured | 10 |
| KPI-05 | Active defects by severity | `count(defects where state ∈ {open, in_progress, fix_candidate, resolved, failed_verification})` grouped by severity at period end | count | measured | — |
| KPI-06 | Defect inflow/outflow | inflow = defects entering `open` in window; outflow = defects entering `verified`/`closed`/`wont_fix` in window | count/period | measured | — |
| KPI-07 | Automation share of regression executions | `count(automated executions in regression-flagged runs/cycles) / count(all executions (manual + automated) of regression-suite test cases)` in window | % | measured | 20 |
| KPI-08 | Flaky test rate | Per binding: `flaky_runs / runs` over the last N=20 runs where executed; project rate = `count(bindings with flakiness ≥ 0.1) / count(active bindings executed in window)` | % | measured | 5 runs per binding |
| KPI-09 | Test and run duration | Median and p90 of `execution.duration_ms` (automated) and of `run.finished_at − run.started_at`; manual median `execution.timer` | ms / min | measured | 10 |
| KPI-10 | Defect detection stage distribution | Share of defects by detection trigger of the first `detected_by` execution: `pr`, `ci`, `schedule`, `manual_cycle`, `exploratory`, `production` (found_in) | % | measured | 10 defects |
| KPI-11 | Defect leakage | `count(defects with found_in = production in window) / count(all defects created in window)`. Shown **only** if production-found defects are recorded in QualityOS | % | measured (data-dependent) | 10 defects |
| KPI-12 | Bug report preparation time | Median of `defect_draft.submitted_at − draft.started_at` (manual) or `approval_requested_at − failure_analyzed_at` (automated drafts) | minutes | measured | 10 |
| KPI-13 | Bug report clarification rate | `count(defects with ≥1 transition back to open from external "needs info"/rejected-for-info OR tagged clarification) / count(defects synced)` | % | measured (mapping-dependent) | 10 |
| KPI-14 | Automated failure false-positive rate | `count(failed final results later annotated as test_defect, environment, infrastructure, flaky (human-confirmed)) / count(failed final results with human-confirmed classification)` | % | measured | 20 |
| KPI-15 | Manual regression effort | Sum of `execution.timer` for manual executions of regression-suite test cases in window | hours | measured (timer-dependent) | — |
| KPI-16 | Cost per test run | `(sandbox_cpu_seconds × compute_rate + storage_bytes_added × storage_rate + ai_cost_for_run_analysis) / runs` | currency | derived/estimated (rates) | 5 runs |
| KPI-17 | Test case quality conformance | `count(approved test case versions passing all mandatory checklist rules) / count(approved test case versions)` | % | measured | 20 |
| KPI-18 | AI cost per accepted artifact | `ai_cost(task family) / count(accepted outputs of that family)`. Families: test suggestions (accepted cases), defect drafts (approved), codegen (merged PRs) | currency | derived | 10 |
| KPI-19 | Traceability completeness | Mean of three ratios: (a) requirements with tests, (b) failed results with classification, (c) defects with ≥1 linked requirement **and** test | % | measured | — |
| KPI-20 | AI suggestion acceptance rate | `(accepted + edited_accepted) / (accepted + edited_accepted + rejected)` per task | % | measured | 20 |
| KPI-21 | Quality gate pass rate | `count(gate_evaluations = pass) / count(gate_evaluations)` per gate | % | measured | 5 |
| KPI-22 | Estimated manual time saved | `Σ automated executions of test cases that were previously manual × manual_minutes(test case)` where `manual_minutes` = measured median manual timer for that case if available, else `est_minutes` field, else project default | hours | **estimated** | — |
| KPI-23 | Mean time to verify fix | Mean of `verified_at − fix_candidate_at` | hours | measured | 5 |
| KPI-24 | Integration reliability | `successful sync runs / all sync runs` per binding; plus `dispatch delivery success` | % | measured | 20 |
| KPI-25 | Regression execution frequency | `count(regression runs completed) / weeks` | runs/week | measured | — |

> These definitions are the source for the KPI registry (`@qos/domain/analytics`, M12-FR-01). A formula change creates a new KPI version (BR-M12-3).

## 4. Estimates model (time saved and ROI), explicit and editable
- **Inputs, all stored and shown:**
  - `manual_minutes` per test case (measured where possible)
  - QA hourly cost (user-entered, optional; can be left blank, in which case only hours are shown)
  - the share of automated executions that genuinely replaced a manual execution, which needs a policy flag on cycles: "manual replaced by automation"
- **Time saved (KPI-22)** counts only executions that replaced planned manual work. Extra automated runs, such as the nightly regression, are reported separately as **added coverage, not savings**.
- **Platform effort cost** is entered by the user and is tracked as an offset, not hidden: test maintenance time (from codegen review and fix tasks, where tracked) plus triage time.
- **Net hours:** `time_saved − (maintenance + triage + platform admin time)`. These inputs are self-reported weekly during the pilot ([27 §5](27-pilot-validation-plan.md)).

## 5. Executive business case structure (template for the post-pilot proposal)
1. **Problem statement**, with baseline numbers from the pilot baseline week (and later from a company baseline study).
2. **What was piloted**: scope, projects, duration, and the configuration (GitHub, Azure Boards, n8n, Claude).
3. **Measured results** (measured only):
   - KPI-02/03 coverage changes
   - KPI-07 automation share
   - KPI-12 bug report preparation time versus baseline
   - KPI-25 regression frequency versus baseline
   - KPI-10 detection-stage shift
   - KPI-14 false-positive rate
   - KPI-20 AI acceptance
   - KPI-24 reliability
4. **Estimated value**, labelled clearly: KPI-22 hours saved, net of maintenance and triage. A sensitivity table shows low, expected, and high values for `manual_minutes` and replacement share.
5. **Quality improvement evidence**: defects found earlier, with examples and links to traceability chains.
6. **Operating cost**: AI cost per month (measured), infrastructure (company server sizing per [28 §6](28-enterprise-rollout.md)), maintenance effort (measured in the pilot), licensing (n8n per OD-01).
7. **ROI**: `(estimated net hours × loaded hourly cost − operating cost) / operating cost`. It is shown as a range and labelled **estimate**.
8. **Risks and limitations**: AI accuracy, flaky tests, adoption, and the open legal and security decisions.
9. **Rollout readiness**: checklist status from [28 §2](28-enterprise-rollout.md).
10. **Ask**: a scoped company pilot with 1 project, 1 QA team, and 8 weeks, plus success criteria agreed up front.

## 6. Operating cost model (enterprise template)
| Cost item | Driver | How to estimate | Provenance |
|---|---|---|---|
| Server(s) | Core host (8 vCPU / 32 GB / 500 GB SSD typical) + runner host(s) per parallel shard capacity (~2 vCPU / 3–4 GB per shard) | IT pricing | estimated |
| Storage | Artifacts GB/month after retention | Pilot measurement × projects | derived |
| AI | Tokens per activity × price table | Pilot ledger × planned activity | derived |
| n8n | CE (if OD-01 approves) or paid plan | Vendor quote | estimated |
| Maintenance | Platform admin hours + test maintenance hours | Pilot measurement | measured → estimated |
| Training/onboarding | Hours per QA engineer | Plan | estimated |
| Upgrades & patching | Monthly dependency/image updates (QualityOS, n8n, Playwright images, Postgres minor) | ~4–8 h/month (validate in pilot) | estimated |
| Support | Internal user support during rollout | Hours/week tracked in R1 | measured → estimated |
