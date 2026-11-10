# M01 — Company Dashboard

> Status: **Planned** · Phases: skeleton in P4, full in P10 · Owner: Product + Frontend · Related: [M12](M12-reports-analytics.md), [29](../29-business-case-and-kpis.md)

## 1. Purpose & responsibilities
The dashboard is the company-wide view of quality across every project the viewer can access. It shows a **read-only projection** and **owns no data**. All numbers come from the analytics read models in [M12](M12-reports-analytics.md), and every number carries its formula and provenance (FR-X-16).

**What it does not do:** it never shows a single composite "quality score" without a breakdown. The *Project Risk Indicator* (§8) shows each factor it is built from.

## 2. Roles
All roles can view it. Each project's data appears only if the viewer has `analytics.read` on that project. Org-wide tiles require `org.analytics.read`, held by org_admin, platform_admin, and viewer when granted at org scope.

## 3. Features
| ID | Feature |
|---|---|
| M01-FR-01 | Portfolio header: total projects (active/archived), active defects by severity, tests executed (7d/30d), first-attempt pass rate, flaky rate |
| M01-FR-02 | Project grid/table: per-project row with requirement coverage, last regression result, open critical/high defects, flaky count, last activity, integration health, risk indicator |
| M01-FR-03 | Trends: execution volume, pass rate, defects opened vs closed, coverage over time. Range 7/30/90 days, optionally compared with the previous period |
| M01-FR-04 | Regression health: latest nightly/regression run per project with status, duration, and delta vs previous |
| M01-FR-05 | Flaky tests leaderboard (top 10 across accessible projects), linked to M08 |
| M01-FR-06 | Recent automation activity feed: runs, automation firings, sync errors, AI tasks (from the outbox/event log) |
| M01-FR-07 | AI analysis summaries: weekly AI-generated narrative per project (from M12's `report.narrative` task), labelled AI and linked to its source metrics |
| M01-FR-08 | Historical comparison: pick two periods or two releases and see KPI deltas |
| M01-FR-09 | Drill-down: every tile opens the underlying filtered list in M08, M10, M04, or M12 |
| M01-FR-10 | Personal "My work" strip: assigned test executions, pending approvals, defects awaiting verification |

## 4. User journeys
J6 (morning check after nightly run), J10 (release readiness, via drill-down). Executive flow: open the dashboard → filter by business unit tag → select the 30-day range → export a PDF summary.

## 5. UI screens
- `S-DSH-01` **Company Dashboard**:
  - layout: KPI strip (6 tiles) → Projects table (sortable, density toggle) → Trends (2×2 charts) → right rail (My work, Activity)
  - every tile has an info icon that opens a definition popover (formula, data window, provenance, last computed time)
- `S-DSH-02` **Comparison view**: two-period picker with a delta table and sparklines.
- States: empty (no projects yet → "Create project" or "Load demo data"), loading (skeleton tiles), stale data banner (analytics refresh more than 2 intervals late), partial (some projects failed to compute → shown per row).

## 6. Domain entities
Reads `metric_snapshots`, `project_health_snapshots`, and `activity_feed` (a view over `audit_events` and `outbox_events`) ([10](../10-database-design.md)). It writes only `dashboard_preferences` (per user: pinned projects, range, density).

## 7. API endpoints
| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/dashboard/summary?range=30d` | Portfolio KPIs (accessible projects only) |
| GET | `/api/v1/dashboard/projects?cursor&sort&filter` | Project rows |
| GET | `/api/v1/dashboard/trends?metric=pass_rate&range=90d&projectIds=` | Time series |
| GET | `/api/v1/dashboard/activity?cursor` | Activity feed |
| GET | `/api/v1/dashboard/compare?from1&to1&from2&to2` | Period comparison |
| GET/PUT | `/api/v1/me/dashboard-preferences` | Preferences |

## 8. Business rules
- BR-M01-1: Metrics follow the exact formulas in [29 §3](../29-business-case-and-kpis.md). The dashboard never computes metrics client-side, except for formatting.
- BR-M01-2: **Project Risk Indicator** is a *categorical* level (Low/Medium/High). It is derived from these factors, and each factor is shown:
  - open critical defects > 0
  - last regression failed or older than 7 days
  - requirement coverage < project target
  - flaky rate > 5%
  - integration health error
  - any unresolved requirement conflicts

  Risk is High if any of the first two hold, Medium if any of the others hold, and Low otherwise. Thresholds are configurable per project.
- BR-M01-3: Projects with fewer than 20 executions in the range show "insufficient data" instead of percentages.
- BR-M01-4: Estimated values (e.g. time saved) are visually distinct: hatched or dashed, with an "Estimate" label.

## 9. Permissions
`dashboard.view` (all roles), `org.analytics.read`, and project `analytics.read`. Export needs `report.export`.

## 10. Provider dependencies
None directly. Provider health comes from M03's health snapshots.

## 11. Events & workflow integration
Consumes `analytics.snapshot.computed` (refresh). No workflow triggers. Class E job `analytics.refresh` (M12) feeds it.

## 12. Security requirements
Every query filters by the user's accessible project IDs, enforced in the repository layer and covered by isolation tests. Exported PDFs carry a watermark with the user and time. No cross-project leakage through aggregated org totals: a viewer without access to project X never sees X counted in totals.

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| Analytics refresh job failing | Show last good snapshot + stale banner with timestamp; alert admin after 2 consecutive failures |
| One project's computation errors | Row shows "Unavailable" with error ID; other rows unaffected |
| Very large portfolios (>200 projects) | Paginated table; KPI aggregation done server-side from snapshots |

## 14. Edge cases
Archived projects excluded by default (toggle). Projects with no environment or runs show onboarding hints. Mixed timezones: ranges evaluated in the org timezone.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M01-AC-01 | Given a user with access to 2 of 3 projects, the summary totals equal the sum over those 2 projects only (verified against seeded data). |
| M01-AC-02 | Every KPI tile opens a definition popover whose formula text matches [29](../29-business-case-and-kpis.md). |
| M01-AC-03 | Clicking the "Open critical defects" tile opens M10's list filtered to those defects, with an identical count. |
| M01-AC-04 | When the latest analytics snapshot is older than 2 refresh intervals, a stale banner shows the snapshot time. |
| M01-AC-05 | A project with <20 executions shows "insufficient data" instead of a pass-rate percentage. |
| M01-AC-06 | The risk indicator shows its contributing factors, and changing a threshold in project settings changes the level on the next refresh. |
| M01-AC-07 | Dashboard summary p95 response ≤ 500 ms with 50 projects and 1M results in seed data (NFR-PERF-02). |

## 16. Implementation tasks
P4: T-P4-50 (dashboard shell + My work strip), T-P4-51 (basic summary from live queries).
P10: T-P10-20 (summary/trends endpoints from snapshots), T-P10-21 (projects table + risk indicator), T-P10-22 (activity feed), T-P10-23 (comparison view), T-P10-24 (definition popovers bound to KPI registry), T-P10-25 (export PDF), T-P10-26 (performance test with large seed).

## 17. Testing requirements
- Unit: risk indicator rules.
- Integration: summary endpoint against a seeded multi-project DB, with an isolation assertion.
- E2E: tile drill-down counts match.
- Visual: dashboard in light/dark and LTR/RTL.
- Performance: k6 or autocannon test against the large seed (P10).

## 18. Dependencies & technical risks
Depends on M12 snapshots, M08/M10 data, and M13 access. Risk: metric definitions drift between M01 and M12. Mitigation: a single KPI registry in `@qos/domain/analytics` used by both.
