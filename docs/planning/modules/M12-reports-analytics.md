# M12 — Reports and Analytics

> Status: **Planned** · Phase: P10 (KPI registry foundations in P4/P6) · Owner: Product + Data/Backend · KPI formulas: [29](../29-business-case-and-kpis.md)

## 1. Purpose & responsibilities
This module computes, stores, and presents quality metrics and reports. It owns:
- the **KPI registry**, the single definition of every metric
- the snapshot computation
- project and cycle reports
- executive summaries
- exports
- the distinction between **measured, derived, and estimated** values

## 2. Roles
| Role | Access |
|---|---|
| All project members | View project reports |
| `qa_lead`, `project_manager` | Create and schedule reports |
| `viewer` (org) | Executive summaries |
| `platform_admin` | Cost reports |

## 3. Features
| ID | Feature |
|---|---|
| M12-FR-01 | KPI registry: id, name, formula (SQL/TS implementation + human-readable text), unit, provenance (`measured`/`derived`/`estimated`), dimensions (project, env, suite, period), minimum sample size |
| M12-FR-02 | Snapshot computation: class E job `analytics.refresh` (incremental, every 15 min + on `run.finalized`/`cycle.closed`) writes `metric_snapshots` (daily grain) and `project_health_snapshots` |
| M12-FR-03 | Project report: coverage (requirement, automated), execution summary, defect trends (opened/closed/by severity/by classification), flaky rate, durations, automation adoption, manual effort, gate performance |
| M12-FR-04 | Cycle/release report: scope, results, defects found, open risks, gate outcome, sign-off section |
| M12-FR-05 | Defect leakage (where measurable): defects found in production-tagged environments or flagged `found_in=production` vs total — shown only when production-found defects are recorded |
| M12-FR-06 | Time-saved estimates: explicit model per [29 §4](../29-business-case-and-kpis.md) with user-editable assumptions (manual minutes per test case), always labelled **Estimate** with assumptions listed |
| M12-FR-07 | Cost reports: AI cost (from ledger), compute time per run (sandbox seconds × configured rate), storage usage; cost per run/test |
| M12-FR-08 | AI quality metrics: suggestion acceptance rate, classification agreement with human overrides, duplicate precision, cost per accepted artifact |
| M12-FR-09 | Executive summary: one-page (PDF/HTML) — highlights, KPI table with trend arrows, measured vs estimated separation, risks; optional AI narrative (`report.narrative`) clearly labelled and constrained to provided numbers |
| M12-FR-10 | Scheduled reports (class O: weekly QA report via n8n delivery; generation itself class E on request) |
| M12-FR-11 | Exports: CSV/XLSX for tables, PDF for reports, JSON API for BI tools (read-only token scope `analytics:read`) |
| M12-FR-12 | Saved report definitions (filters, sections) per project |

## 4. User journeys
J10 (release readiness). Weekly report: the n8n schedule claims a slot → the Automation API calls `reports/weekly` → the report is generated (E) → n8n delivers the PDF link to the channel.

## 5. UI screens
- `S-RPT-01` Reports home (project)
- `S-RPT-02` Report viewer with sections and metric definition popovers
- `S-RPT-03` Report builder (choose sections and filters)
- `S-RPT-04` Executive summary preview/export
- `S-RPT-05` Cost and usage
- `S-RPT-06` AI quality

## 6. Domain entities
`kpi_definitions` (seeded from code registry, versioned), `metric_snapshots` (kpi_id, project_id, dims hash, period, value, numerator, denominator, sample_size, provenance, computed_at, kpi_version), `project_health_snapshots`, `report_definitions`, `report_instances` (generated artifact refs, inputs hash), `cost_ledger_daily` (rollup of AI ledger + compute + storage).

## 7. API endpoints
| Method | Path |
|---|---|
| GET | `/api/v1/kpis` (registry with formulas) |
| GET | `/api/v1/projects/{key}/metrics?kpi=&from=&to=&dims=` |
| GET/POST | `/api/v1/projects/{key}/reports/definitions` |
| POST | `/api/v1/projects/{key}/reports:generate` (definitionId or ad-hoc) → operation → report instance |
| GET | `/api/v1/projects/{key}/reports/instances/{id}` (`format=html|pdf|json`) |
| GET | `/api/v1/costs?from&to&projectKey` |
| POST | `/automation/v1/reports/weekly` (service token) |

## 8. Business rules
- BR-M12-1: Each metric shows numerator, denominator, and sample size when expanded. Below the minimum sample size, the metric shows "insufficient data".
- BR-M12-2: Estimated values are never summed with measured values in a single figure.
- BR-M12-3: A snapshot stores the KPI version it was computed with. A formula change bumps the version. Historical snapshots are recomputed only on explicit backfill, and the backfill is noted on the charts.
- BR-M12-4: An AI narrative may use only numbers present in the report input JSON. After generation, a validator checks that every number in the narrative appears in the input. The narrative is dropped if validation fails.
- BR-M12-5: Cost rates (compute $/hour, storage $/GB-month) are configured by an admin and labelled `estimated`. The AI cost comes from the provider's usage data and the configured price table, and is labelled `derived`.

## 9. Permissions
`analytics.read`, `report.create`, `report.schedule`, `report.export`, `cost.read`.

## 10. Provider dependencies
AI task `report.narrative` (optional). Storage for report artifacts.

## 11. Events & workflow integration
- Consumes: `run.finalized`, `cycle.closed`, `defect.state.changed`, `requirement.version.approved`, which trigger an incremental refresh.
- Emits: `analytics.snapshot.computed`, `report.generated`.

## 12. Security requirements
Reports respect project access, and org totals include only accessible projects. PDF exports carry a watermark. The `analytics:read` token scope is read-only and limited to aggregates. It cannot read requirement text.

## 13. Failure scenarios & error handling
- Refresh failure: keep the last snapshot, show a stale banner, retry, and alert after 2 failures.
- PDF rendering failure: offer an HTML fallback.
- Very large ranges: pre-aggregated daily snapshots keep query cost bounded.

## 14. Edge cases
- Projects with no runs: coverage KPIs are still valid, and execution KPIs show "insufficient data".
- Changing time zones: snapshots use org-timezone day boundaries, stored with the boundary convention.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M12-AC-01 | Every KPI in [29](../29-business-case-and-kpis.md) exists in the registry, and its computed value on the seeded dataset equals an independently computed SQL fixture. |
| M12-AC-02 | The executive summary separates measured and estimated sections, and the estimated section lists its assumptions. |
| M12-AC-03 | An AI narrative containing a number not in the input is rejected, and the report renders without a narrative plus a notice. |
| M12-AC-04 | After a run is finalized, the project metrics reflect it within 2 minutes. |
| M12-AC-05 | A report generated for a user lacking access to project B contains no data from B. |
| M12-AC-06 | The cost report totals equal the sum of AI ledger entries plus compute plus storage estimates for the period. |

## 16. Implementation tasks
- T-P10-01: KPI registry + versions
- T-P10-02: snapshot job (incremental)
- T-P10-03: metrics API
- T-P10-04: project report
- T-P10-05: cycle/release report
- T-P10-06: time-saved estimate model UI
- T-P10-07: cost ledger rollup + cost report
- T-P10-08: AI quality metrics
- T-P10-09: executive summary + PDF
- T-P10-10: narrative task + number validator
- T-P10-11: weekly report automation endpoint
- T-P10-12: exports
- T-P10-13: saved definitions
- T-P10-14: KPI fixture tests

## 17. Testing requirements
- KPI fixture tests: a seeded dataset with hand-computed expected values.
- Snapshot idempotency: recomputing gives the same values.
- PDF smoke test.
- Narrative validator unit tests.

## 18. Dependencies & technical risks
Depends on data from M04–M10.

| Risk | Mitigation |
|---|---|
| Metric misuse by management | Published formulas, sample-size gating, and "estimate" labels |
