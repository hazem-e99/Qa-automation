# M06 — Manual Testing Workspace

> Status: **Planned** · Phase: P4 · Owner: Frontend + QA Lead · Engine: [16](../16-test-management-engine.md)

## 1. Purpose & responsibilities
A fast, focused workspace where QA engineers run manual tests. Most of the company's QA work is manual today, so the product is useful even before any automation exists. This module covers:
- test cycles (planned manual runs)
- assignments
- step-by-step execution
- evidence
- exploratory sessions
- creating defects from failures
- retests
- manual execution history

Manual results use the same `test_runs`, `test_executions`, and `test_results` model as automated runs ([09 §4](../09-domain-model.md)). The only difference is `kind = manual`.

## 2. Roles
| Role | Can do |
|---|---|
| `qa_lead` | Create and manage cycles |
| `qa_engineer` | Execute |
| `qc_reviewer` | Review results and evidence |
| `developer` | Read; comment on results linked to their defects |

## 3. Features
| ID | Feature |
|---|---|
| M06-FR-01 | Test cycles: name, environment, build/version label, scope (suites, dynamic query, explicit cases), schedule window, assignees (round-robin, by component, manual), entry/exit criteria |
| M06-FR-02 | My Queue: assigned executions across projects; sort by priority/due; resume where left |
| M06-FR-03 | Step runner: one step at a time or full list; per-step status pass/fail/blocked/skipped + actual result + evidence; overall status auto-derived (any fail → failed; any blocked & no fail → blocked) with override + reason |
| M06-FR-04 | Statuses: `not_run`, `in_progress`, `passed`, `failed`, `blocked`, `skipped`; `blocked` requires blocker reason (environment down, dependency defect, data missing, other) and optional linked defect |
| M06-FR-05 | Evidence: paste/drag screenshots, file attachments (≤ 25 MB each), screen recording upload, URL capture, console/network log paste; auto-metadata (time, step, tester, browser/OS user-entered or detected via optional extension later) |
| M06-FR-06 | Keyboard-first: `P/F/B/S` step statuses, `N` next, `E` evidence, `D` create defect, `Ctrl+Enter` complete |
| M06-FR-07 | Timer: per execution duration tracking (auto start/pause on focus loss optional) — feeds manual effort KPIs |
| M06-FR-08 | Create defect from failed step: prefilled draft (title suggestion, steps up to failure, expected vs actual, environment, build, evidence) → M10 draft workflow |
| M06-FR-09 | Retest: when linked defect becomes `fix_candidate` or `resolved`, a retest execution is auto-proposed to the original tester/cycle; result updates defect verification |
| M06-FR-10 | Exploratory sessions: charter (from M05 or ad-hoc), time box, timestamped notes, tags (bug/question/idea/risk), evidence, convert note → defect or → new test case draft |
| M06-FR-11 | Cycle dashboard: progress (by status, assignee, priority), burndown, blocked list, defects found, requirement coverage executed |
| M06-FR-12 | Execution history per test case: all runs (manual and automated) with version executed, environment, result |
| M06-FR-13 | Bulk assign/reassign; clone cycle; carry over failed/blocked into a new cycle |
| M06-FR-14 | Offline-tolerant runner: unsaved step results buffered locally (IndexedDB) and synced with idempotency keys when connection returns |
| M06-FR-15 | Quick modes for experienced testers: "All steps passed" (one keystroke `Shift+P`, with a confirmation for P0/P1 cases), bulk-mark selected executions in the queue as `skipped (not applicable)` with a reason, and a compact checklist view for short test cases. Every quick action is recorded as a normal step-level result, so the audit trail is complete |

## 4. User journeys
J4 (manual cycle), J7 (retest). Exploratory journey: start a session from a charter → take notes while testing → convert 2 notes into defects → end the session → review the summary.

## 5. UI screens
- `S-MAN-01` My Queue
- `S-MAN-02` Step Runner (focused, distraction-free; split layout: steps left, evidence/actual right; sticky status bar)
- `S-MAN-03` Cycle Planner (scope builder, assignment, criteria)
- `S-MAN-04` Cycle Dashboard
- `S-MAN-05` Exploratory Session (timer, note stream, quick tags)
- `S-MAN-06` Execution detail (read-only history view, evidence gallery)

## 6. Domain entities
- **Created by this module:** `test_runs` (kind `manual`, linked to `test_cycles`), `test_cycles`, `cycle_assignments`, `test_executions`, `step_results`, `artifacts` (evidence), `exploratory_sessions`, `session_notes`.
- **Referenced:** `test_case_versions`, `defects`.

## 7. API endpoints
| Method | Path |
|---|---|
| GET/POST | `/api/v1/projects/{key}/cycles` · GET/PATCH `/{id}` · POST `/{id}:start` · `:close` · `:clone` · `:carry-over` |
| PUT | `/api/v1/projects/{key}/cycles/{id}/assignments` |
| GET | `/api/v1/me/queue?status&projectKey` |
| GET | `/api/v1/projects/{key}/executions/{execId}` |
| POST | `/api/v1/projects/{key}/executions/{execId}:start` · `:complete` (Idempotency-Key) |
| PUT | `/api/v1/projects/{key}/executions/{execId}/steps/{stepNo}` (status, actual, evidence ids) |
| POST | `/api/v1/projects/{key}/artifacts:upload-url` → signed upload; POST `/artifacts/{id}:finalize` |
| POST | `/api/v1/projects/{key}/executions/{execId}/defect-draft` |
| GET/POST | `/api/v1/projects/{key}/sessions` · POST `/{id}/notes` · `/{id}:end` · `/notes/{noteId}:convert` |

## 8. Business rules
- BR-M06-1: An execution is bound to exactly one TestCaseVersion: the latest approved version at cycle start, or at execution start if the policy is `latest_at_execution`.
- BR-M06-2: A completed execution can be **reopened** only by `qa_lead`, with a reason. This creates a new attempt, and the original attempt is kept, so manual results are not silently overwritten.
- BR-M06-3: A cycle cannot close while executions are `in_progress`. Closing with `not_run` items requires choosing one of two options: mark them skipped (with reason), or carry them over.
- BR-M06-4: Evidence files are immutable once attached. Removing one hides it from views but keeps it in the audit trail until retention expires.
- BR-M06-5: A failed step with no actual-result text and no evidence triggers a soft warning. The project setting `require_evidence_on_fail` can make it a hard block.
- BR-M06-6: A retest result of `passed` updates the defect's verification status only through M10's rules (BR-M10-6).

## 9. Permissions
`cycle.manage`, `execution.run` (own assignments; `qa_lead` can run anyone's), `execution.reopen`, `evidence.upload`, `session.run`, `defect.draft.create`.

## 10. Provider dependencies
`ObjectStorage` (evidence). Optional AI tasks: `defects.draft_from_manual` (improve wording) and `sessions.summarize`.

## 11. Events & workflow integration
- Emits:
  - `cycle.started`
  - `cycle.closed`
  - `execution.completed`
  - `execution.failed`
  - `execution.blocked`
  - `session.ended`
- Consumes:
  - `defect.fix_candidate` and `defect.resolved` (to propose a retest)
- Class O notifications:
  - an assignment notification
  - a cycle-end summary to the lead

## 12. Security requirements
- Evidence upload uses signed, single-use, size-capped URLs with MIME sniffing. Images are re-encoded server-side to strip EXIF and active content. SVG is converted to PNG or rejected.
- Testers can see only the cycles of projects where they are members.
- A sensitive-data warning appears when pasted text matches redaction patterns (e.g. a token). The tester can mask it before saving.

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| Browser crash mid-execution | Step results already saved per step (autosave); local buffer recovers unsynced ones |
| Network loss | Offline banner; buffered writes with idempotency keys; conflict if execution reassigned meanwhile → prompt |
| Large video upload fails | Resumable upload (chunked) with retry; execution completion not blocked by pending upload (flagged "evidence uploading") |
| Test case version superseded during cycle | Execution continues on bound version; banner shows newer version exists |

## 14. Edge cases
- The same test case appears twice in one cycle (two environments or data sets): allowed, as separate executions labelled with their parameters.
- A tester is removed from the project mid-cycle: their assignments are returned to the pool, and completed results are kept.
- Time zones: due dates use the project's timezone.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M06-AC-01 | A tester can execute a 10-step test case with only the keyboard, and each step is persisted within 1 s of its status key. |
| M06-AC-02 | Marking any step failed sets the execution to failed. Override needs a reason, which is audited. |
| M06-AC-03 | "Create defect" from a failed step opens a draft that contains the steps up to the failure, the expected vs actual result, the environment, the build, and the attached evidence. |
| M06-AC-04 | With the network disconnected for 2 minutes during execution, no step results are lost, and no duplicates are created after reconnection. |
| M06-AC-05 | Reopening a completed execution creates attempt 2, and attempt 1 is still visible in history. |
| M06-AC-06 | When a linked defect becomes `fix_candidate`, a retest execution is proposed to the original tester within one dispatch cycle. |
| M06-AC-07 | The cycle dashboard counts match the execution table for the same filters. |
| M06-AC-08 | An uploaded JPEG has its EXIF metadata stripped, and an SVG upload is converted to PNG or rejected. |

## 16. Implementation tasks
- T-P4-20 (runs/executions/step results for the manual kind)
- T-P4-21 (cycles + assignments)
- T-P4-22 (My Queue API/UI)
- T-P4-23 (step runner UI with keyboard + autosave)
- T-P4-24 (evidence upload pipeline + image sanitization)
- T-P4-25 (offline buffer + idempotent sync)
- T-P4-26 (defect draft from step → M10)
- T-P4-27 (retest proposal)
- T-P4-28 (exploratory sessions)
- T-P4-29 (cycle dashboard)
- T-P4-30 (execution history)
- T-P4-31 (carry-over/clone)
- T-P4-32 (timer + effort capture)

## 17. Testing requirements
- E2E for J4 and J7 in demo mode.
- Offline simulation test with Playwright network emulation.
- Accessibility test of the step runner (keyboard only, screen reader labels).
- Upload security tests: polyglot files, oversized files, EXIF.

## 18. Dependencies & technical risks
Depends on M05 (test cases), M10 (defect drafts), and storage.

| Risk | Mitigation |
|---|---|
| The runner UX is not faster than the testers' current spreadsheets | Validate with the owner during P4 (time per execution measured), and iterate before P5 |
