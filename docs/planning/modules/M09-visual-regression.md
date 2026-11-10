# M09 — Visual Regression Testing

> Status: **Planned** · Phase: P9 · Owner: QA Automation Architect + Frontend · Engine: [17 §10](../17-test-execution-engine.md)

## 1. Purpose & responsibilities
Catch unintended visual changes with deterministic, reviewable screenshot comparison across browsers, viewports, themes, and **RTL/LTR**. Owns baselines (approved, versioned), comparisons, diff visualization, review/approval, ignore regions, and visual failure classification.

## 2. Roles
`qa_engineer` reviews diffs and proposes baseline updates; `qa_lead` (or policy-defined approver) approves baseline changes; developers view.

## 3. Features
| ID | Feature |
|---|---|
| M09-FR-01 | Visual checkpoints in tests: `toHaveScreenshot(name)` via engine; checkpoint identity = (binding, checkpoint name, browser, viewport, locale, direction, theme) |
| M09-FR-02 | Baselines stored in QualityOS (object storage + metadata), versioned; optional mirror into test repo is **not** used — single source of truth avoids silent Git-side updates |
| M09-FR-03 | Comparison: engine compares against baseline fetched at run start (pinned baseline version recorded in manifest); thresholds (`maxDiffPixelRatio`, per-checkpoint override) |
| M09-FR-04 | Diff visualization: side-by-side, overlay slider, diff heatmap, toggle ignore regions |
| M09-FR-05 | Review queue: visual failures grouped by checkpoint; actions **Approve as new baseline** (creates baseline version n+1, needs approval policy), **Reject (is a bug)** → defect draft, **Mark environment noise** → classification + optional ignore region proposal |
| M09-FR-06 | Ignore regions / masks: rectangles or locator-based masks per checkpoint, versioned with the baseline; dynamic content masking recommendations |
| M09-FR-07 | Responsive matrix: viewports per project (e.g., 375×812, 768×1024, 1440×900) |
| M09-FR-08 | RTL/LTR: locale/direction matrix (e.g., `en-US/ltr`, `ar-EG/rtl`); RTL-specific checks — mirrored layout expectations, no clipped Arabic glyphs, icon direction |
| M09-FR-09 | Determinism controls: pinned browser image (fonts installed in image), animations disabled, caret hidden, fixed timezone/locale, `reducedMotion`, wait-for-fonts, network-idle option, mocked dates via engine clock |
| M09-FR-10 | Baseline bootstrap: first run of a new checkpoint produces a *candidate* baseline requiring approval (no auto-accept) |
| M09-FR-11 | Failure classification for visuals: `visual_change_intended` (approved), `visual_bug`, `rendering_noise` (anti-aliasing/fonts), `dynamic_content` |
| M09-FR-12 | Baseline history & rollback (approve previous version as current) |

## 4. User journeys
After a UI redesign merges, nightly run shows 14 visual diffs → reviewer opens queue → approves 12 as intended (baseline v2, approval by QA lead), marks 1 as bug (defect draft with diff images), adds a mask for a dynamic date region on 1.

## 5. UI screens
`S-VIS-01` Visual review queue; `S-VIS-02` Checkpoint detail (baseline history, matrix grid of variants); `S-VIS-03` Diff viewer (side-by-side / slider / heatmap, mask editor); `S-VIS-04` Visual settings (matrix, thresholds, determinism options).

## 6. Domain entities
`visual_checkpoints`, `visual_baselines` (versioned; image artifact, masks, approved_by, approval ref), `visual_comparisons` (per attempt: actual artifact, diff artifact, ratio, verdict), `visual_reviews`.

## 7. API endpoints
| Method | Path |
|---|---|
| GET | `/api/v1/projects/{key}/visual/checkpoints?status` · `/{id}` · `/{id}/baselines` |
| GET | `/api/v1/projects/{key}/visual/review-queue` |
| POST | `/api/v1/projects/{key}/visual/comparisons/{id}:approve-baseline` · `:mark-bug` · `:mark-noise` |
| PUT | `/api/v1/projects/{key}/visual/checkpoints/{id}/masks` |
| POST | `/api/v1/projects/{key}/visual/baselines/{id}:rollback` |
| GET | `/internal/v1/sandbox/runs/{id}/baselines` (sandbox fetch with run token) |

## 8. Business rules
- BR-M09-1: Baselines change **only** through an approved review action; no code path (including AI fix proposals, BR-M07 guard) may update them.
- BR-M09-2: Baseline approvals follow approval policy `visual.baseline.approve` (default: 1 approver with `qa_lead`).
- BR-M09-3: Comparison uses the baseline version pinned at run start; approvals during a run affect next runs only.
- BR-M09-4: Baselines are environment-independent but **image-dependent**: a change of browser image major version invalidates baselines to `needs_rebaseline` (candidate generation run proposed).
- BR-M09-5: Masks are part of the baseline version; changing masks creates a new version.

## 9. Permissions
`visual.review`, `visual.baseline.approve`, `visual.mask.edit`, `visual.settings.manage`.

## 10. Provider dependencies
`TestEngine` capability `engine.visual_compare@1`; `ObjectStorage`.

## 11. Events & workflow integration
Emits `visual.diff.detected`, `visual.baseline.approved`, `visual.baseline.invalidated`. Class O: notify reviewers of new diffs.

## 12. Security requirements
Screenshots may contain sensitive data → same artifact protections; masking guidance for PII fields; retention class `visual` configurable.

## 13. Failure scenarios & error handling
Font differences after image update → BR-M09-4 flow; flaky rendering → auto-rerun checkpoint once within attempt before failing (engine option) and classify `rendering_noise` if second passes; missing baseline file in storage → checkpoint `error`, alert, never treated as pass.

## 14. Edge cases
Very tall pages (full-page screenshots) capped (default 10,000 px) with warning; canvas/WebGL content → recommend masks or element-level checks; locale fonts missing for Arabic → image validation check at P0 ensures `fonts-noto-core`/Arabic fonts in sandbox image.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M09-AC-01 | First run of a new checkpoint creates a candidate baseline that is not used for pass/fail until approved. |
| M09-AC-02 | A deliberate CSS change in the demo app produces a diff shown in side-by-side, slider, and heatmap modes. |
| M09-AC-03 | Approving a diff creates baseline version n+1 attributed to the approver; the next run passes. |
| M09-AC-04 | No API path other than review approval can create or modify baselines (API test enumerating endpoints + AI fix proposal guard test). |
| M09-AC-05 | An Arabic RTL page variant is captured and compared separately from the LTR variant. |
| M09-AC-06 | A masked dynamic region does not cause diffs when its content changes. |
| M09-AC-07 | Changing the Playwright image major version marks baselines `needs_rebaseline`. |

## 16. Implementation tasks
T-P9-20 (checkpoint identity + baseline model), T-P9-21 (baseline fetch for sandbox + pinning), T-P9-22 (engine visual compare integration), T-P9-23 (determinism defaults + font set in images), T-P9-24 (diff viewer UI), T-P9-25 (review queue + actions), T-P9-26 (masks editor), T-P9-27 (approval policy integration), T-P9-28 (RTL/viewport matrix config), T-P9-29 (invalidation on image change), T-P9-30 (rollback), T-P9-31 (retention), T-P9-32 (visual E2E on demo app).

## 17. Testing requirements
Golden image tests on demo app across matrix; determinism test (run 10× unchanged → 0 diffs); RTL rendering checks.

## 18. Dependencies & technical risks
Depends on M08. Risk: cross-OS rendering differences — mitigated by always rendering in the pinned container image (never host browsers).
