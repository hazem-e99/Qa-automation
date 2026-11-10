# 03 — Business Requirements

> Status: **Planned** · Owner: Product Manager · Last reviewed: 2026-11-09

Each business requirement (BR) traces to one of the objectives in brief §2, to the modules that deliver it, and to the KPI that measures it ([29](29-business-case-and-kpis.md)).

| ID | Business requirement | Objective | Delivered by | Measured by |
|---|---|---|---|---|
| BR-01 | Cut the repetitive manual effort of regression execution. | Reduce repetitive manual QA effort | M07, M08, M11 | KPI-07 Automation share of regression executions, KPI-15 Manual regression hours |
| BR-02 | Increase reliable regression coverage of approved requirements. | Increase regression coverage | M05, M07, M08 | KPI-02 Requirement coverage, KPI-03 Automated requirement coverage |
| BR-03 | Find defects earlier: before merge or before release. | Earlier defect detection | M08, M11 (CI/PR triggers), M10 | KPI-10 Defect detection stage distribution, KPI-11 Defect leakage |
| BR-04 | Make test design consistent across engineers and projects. | Consistency of test design | M05 (structured templates, AI suggestions), M13/M14 (approval rules) | KPI-17 Test case quality checklist conformance |
| BR-05 | Shorten the time it takes to prepare a high-quality bug report. | Reduce bug-report time | M10 | KPI-12 Median bug report preparation time, KPI-13 Bug report reopen/clarification rate |
| BR-06 | Trace every link end to end: requirement → test case → execution → defect → fix → verification. | Traceability | M04, M05, M08, M10 + traceability graph | KPI-02, KPI-19 Traceability completeness |
| BR-07 | Standardize QA practices: statuses, severities, templates, gates. | Standardized practice | M02 (project templates), M14 (policies) | Adoption audit |
| BR-08 | Give management quality metrics with clear definitions. | Measurable metrics | M01, M12 | KPI definitions published, data provenance flags |
| BR-09 | Keep human expertise and approval control over AI and automation. | Human control | Approval Policy Engine (M14), AI gateway (M05, M10) | KPI-20 AI suggestion acceptance rate, approval audit |
| BR-10 | Stay extensible with no vendor lock-in. | No lock-in | Provider framework (M03) | Provider contract suite pass rate, provider-switch drill (WF-F) |
| BR-11 | Run fully on one local machine for the pilot, and migrate to company infrastructure without redesign. | Local-first, enterprise path | [23](23-local-deployment.md), [28](28-enterprise-rollout.md) | Migration rehearsal in P13 |
| BR-12 | Keep the cost of operating the platform visible and controlled: AI tokens, compute, storage. | Cost transparency | M14 cost monitoring, AI ledger | KPI-16 Cost per run, KPI-18 AI cost per accepted artifact |
| BR-13 | Never process company data or credentials during the personal pilot without explicit permission. | Compliance | Pilot checklist | Pilot governance review |
| BR-14 | Support Arabic and English documents and UI, including RTL testing. | Locale fit | M04 (parsing), M09 (RTL visual tests), UI i18n | Extraction accuracy by language; RTL visual test coverage |

## Constraints
- **C-01** Planning first: implementation starts only after the owner approves this package.
- **C-02** The pilot budget is personal. AI spend has a configurable monthly cap (AS-17).
- **C-03** One builder (AS-01), so the roadmap must ship value incrementally.
- **C-04** Company adoption depends on security and legal review (n8n license OD-01, AI data processing OD-08).

## Stakeholder acceptance (business level)
The business requirements are satisfied when:
1. Every BR has at least one module acceptance criterion in [32](32-acceptance-criteria-matrix.md) that passes.
2. Every KPI named above can be computed from stored data, and its formula is published.
3. The pilot report ([27 §8](27-pilot-validation-plan.md)) shows measured values for KPI-02, 07, 12, 14, 16, and 20, compared with the baseline.
