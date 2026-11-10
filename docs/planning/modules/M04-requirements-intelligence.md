# M04 — Requirements Intelligence Center

> Status: **Planned** · Phases: P3 (ingestion, normalization, review, versioning, traceability), P5 (AI analysis: extraction assist, conflicts, gaps, duplicates) · Owner: Backend + AI Engineer · Engine spec: [14](../14-requirements-engine.md)

## 1. Purpose & responsibilities
This module turns requirements from **any number of sources** into one normalized, versioned, approved set. Each requirement has provenance back to its source. Its responsibilities are:
- ingestion from Azure Boards, documents, spreadsheets, and manual entry
- extraction and normalization
- analysis: duplicates, conflicts, gaps, ambiguity
- human review and approval
- versioning and change detection
- impact analysis on tests
- the requirement side of the traceability graph

**Guarantee:** everything downstream of an *approved RequirementVersion* (test design, execution, defects, coverage) works the same way whatever the source.

## 2. Roles
- Configure sources and upload documents: `qa_lead`, `qa_engineer`.
- Approve requirements: `qa_lead`, or a delegated approver per policy (e.g. `project_manager` as business approver).
- Read: everyone with project access.

## 3. Features
| ID | Feature |
|---|---|
| M04-FR-01 | Requirement sources per project (0..n): `azure_boards` (WIQL query or area/iteration filter, work item types: User Story, PBI, Task, Feature, Bug-as-requirement off by default), `document_set` (DOCX/PDF), `spreadsheet` (XLSX/CSV with column mapping), `manual` |
| M04-FR-02 | Azure Boards sync: incremental by `System.ChangedDate`, revision-aware; maps title, description, acceptance criteria field, state, tags, area, iteration, links (parent/child/related), attachments (metadata only by default) |
| M04-FR-03 | Document upload: DOCX, PDF (text and scanned), XLSX/CSV; max 50 MB (configurable); versioned as a *document series* (same logical document, new version) |
| M04-FR-04 | Parsing via `DocumentParser` into blocks with locators (page, section path, paragraph index, table/row/col); language per block (ar/en/mixed); OCR confidence for scanned pages |
| M04-FR-05 | Extraction: candidate requirements and acceptance criteria from parsed blocks. Uses deterministic structure first (headings, numbered lists, "shall/must/يجب" patterns, table columns), then AI-assisted extraction (P5) |
| M04-FR-06 | Spreadsheet mapping: user maps columns → ID, title, description, AC, priority, module; mapping saved per source and re-applied to new versions |
| M04-FR-07 | Manual entry: rich text editor with structured AC list, attachments, tags |
| M04-FR-08 | Extraction review: side-by-side source viewer (PDF page render, DOCX HTML, sheet grid) with highlighted locator, candidate editor, confidence chips, bulk accept/merge/split/reject |
| M04-FR-09 | Normalization: candidates become a canonical `Requirement` (stable key `PRJ-R-n`) with a `RequirementVersion` (immutable) and `AcceptanceCriteria`. Each AC is tagged `origin=source|inferred` |
| M04-FR-10 | Approval workflow: `draft → in_review → approved`; `approved → superseded` (new version approved) or `obsolete` (withdrawn). Configurable approver count and roles per policy |
| M04-FR-11 | Versioning: every content change (from source sync or edit) creates a new *draft* version. The approved version stays effective until the new one is approved |
| M04-FR-12 | Duplicate detection (P5): embedding similarity (pgvector) + title/key heuristics across sources. Shown as suggestions; merge keeps both provenances |
| M04-FR-13 | Conflict detection (P5): AI task `requirements.analyze_conflicts` over candidate pairs pre-filtered by topic similarity. Conflicts are records that need resolution (choose authoritative, reconcile with a new text, mark not-a-conflict) |
| M04-FR-14 | Gap and ambiguity analysis (P5): missing error handling, undefined limits, vague terms ("fast", "user-friendly"), missing roles. Suggestions only; inferred AC require approval |
| M04-FR-15 | Change detection: new source snapshot is diffed against the previous one (added/changed/removed items) at requirement and AC level |
| M04-FR-16 | Impact analysis: for changed or removed approved requirements, list linked test case versions, automation bindings, open defects. Flag tests `needs_review`. Optionally run AI task `tests.suggest_updates` |
| M04-FR-17 | Traceability view: requirement ↔ test cases ↔ latest results ↔ defects; coverage status per requirement (`uncovered`, `covered_manual`, `covered_automated`, `covered_both`, `failing`) |
| M04-FR-18 | Requirement hierarchy: epics/features/stories from Azure links or document sections; coverage rolls up |
| M04-FR-19 | Bilingual support: Arabic/English rendering with correct direction per block; search normalizes Arabic (alef/ya/ta-marbuta variants, diacritics) |
| M04-FR-20 | Export: requirements + AC + coverage to XLSX/CSV; traceability matrix export |

## 4. User journeys
J2 (mixed sources), J8 (document change). Spreadsheet journey: upload XLSX → map columns (saved) → preview 10 rows → import as candidates → review → approve.

## 5. UI screens
- `S-REQ-01` Requirements list: tree/flat toggle; filters by source, state, coverage, tag, language, conflicts; columns key/title/source/state/version/coverage/last change.
- `S-REQ-02` Requirement detail: header (key, state, version selector); body; AC list with origin badges; provenance panel (source chips → open locator); traceability tab; history tab (version diff); discussion.
- `S-REQ-03` Extraction review workspace: split view of source viewer and candidates; keyboard flow (J/K navigate, A accept, E edit, M merge, X reject).
- `S-REQ-04` Change/diff view per snapshot pair, with an impact panel.
- `S-REQ-05` Analysis findings inbox: conflicts, gaps, duplicates, with resolution actions.
- `S-REQ-06` Sources configuration (list + per-source settings + sync status).
- `S-REQ-07` Upload dialog (drag-drop, series selection, language hint, OCR toggle).

## 6. Domain entities
Owned by this module:

| Entity | Purpose |
|---|---|
| `requirement_sources` | Configured sources per project |
| `source_documents` | Document series |
| `source_snapshots` | Immutable file version or work-item revision, with `checksum` and `external_ref_id` |
| `parsed_documents` | Parser output metadata; the JSON is held in storage |
| `extracted_items` | Each carries a locator, text, kind (`requirement`/`ac`/`context`), confidence, and language |
| `requirements` | Stable identity |
| `requirement_versions` | Immutable; text, ac set hash, `origin`, `state`, approval refs |
| `acceptance_criteria` | Per version |
| `requirement_provenance` | version ↔ extracted items, many-to-many |
| `requirement_findings` | Type `conflict`/`gap`/`duplicate`/`ambiguity`, status, AI execution ref |
| `requirement_links` | Hierarchy, related |
| `requirement_embeddings` | |

Shared: `traceability_links` ([09 §5](../09-domain-model.md)).

## 7. API endpoints
| Method | Path |
|---|---|
| GET/POST | `/api/v1/projects/{key}/requirement-sources` · PATCH/DELETE `/{id}` · POST `/{id}:sync` |
| POST | `/api/v1/projects/{key}/documents` (multipart upload; `seriesId?`, `languageHint?`, `ocr?`) returns snapshot + parse operation |
| GET | `/api/v1/projects/{key}/documents/{seriesId}/versions` · `/snapshots/{id}/parsed` · `/snapshots/{id}/render?page=` |
| GET | `/api/v1/projects/{key}/extracted-items?snapshotId&status` · POST `:bulk` (accept/merge/split/reject) |
| GET/POST | `/api/v1/projects/{key}/requirements` (POST = manual create) |
| GET/PATCH | `/api/v1/projects/{key}/requirements/{reqKey}` (PATCH creates a draft version) |
| GET | `/api/v1/projects/{key}/requirements/{reqKey}/versions` · `/versions/{n}` · `/diff?from&to` |
| POST | `/api/v1/projects/{key}/requirements/{reqKey}/versions/{n}:submit` · `:approve` · `:reject` · `:obsolete` |
| GET | `/api/v1/projects/{key}/requirements/{reqKey}/trace` |
| GET | `/api/v1/projects/{key}/findings?type&status` · POST `/findings/{id}:resolve` |
| POST | `/api/v1/projects/{key}/requirements:analyze` (async AI analysis over a selection) |
| GET | `/api/v1/projects/{key}/snapshots/{a}/diff/{b}` · `/impact?snapshotId=` |
| GET | `/api/v1/projects/{key}/coverage/requirements` |

## 8. Business rules
- BR-M04-1: **AI never approves.** Items with `origin=inferred` are visually distinct. They require explicit approval and cannot be bulk-approved together with source items unless the approver ticks "includes inferred items" (recorded in the audit).
- BR-M04-2: RequirementVersions are immutable. Corrections create a new version.
- BR-M04-3: Each RequirementVersion has ≥1 provenance link. Manual entries link to a `manual` snapshot recording author and time.
- BR-M04-4: A source re-sync that changes an *approved* requirement creates a new draft version and an impact analysis. It **does not** alter the approved version, and it **does not** change tests automatically.
- BR-M04-5: Removing an item at the source marks the requirement `source_removed` (a warning). The requirement becomes `obsolete` only by human action.
- BR-M04-6: An approved requirement cannot have an open `conflict` finding. Approval is blocked until each conflict is resolved or waived with a reason (waiving needs `qa_lead`).
- BR-M04-7: Extraction confidence below 0.6 (configurable) forces manual review. Such items are excluded from bulk accept.
- BR-M04-8: For items synced from an external requirements source (any provider), the external source is the authority for their text. QualityOS edits to a synced requirement are stored as *local overlays*, marked "diverged from source", and never written back unless the adapter declares a write-back capability and a policy allows it (neither exists in the pilot).
- BR-M04-9: Multiple sources can produce the same logical requirement. Merge keeps one canonical requirement with multiple provenances. A later change in any source triggers a new draft version.

## 9. Permissions
`requirement.read`, `requirement.create`, `requirement.edit`, `requirement.submit`, `requirement.approve`, `requirement.obsolete`, `requirement_source.manage`, `document.upload`, `finding.resolve`, `finding.waive`.

## 10. Provider dependencies
| Port / capability | Role | Notes |
|---|---|---|
| `RequirementsSource` port | | |
| `requirements.list_changed@1` | required | |
| `requirements.get@1` | required | |
| `requirements.revisions@1` | optional | Exact versioning |
| `requirements.attachments.read@1` | optional | |
| `requirements.links@1` | optional | Hierarchy |
| `DocumentParser` (`parse.docx`, `parse.pdf`, `parse.pdf_ocr`, `parse.xlsx`) | | |
| `AIProvider` via AI Gateway | | Tasks `requirements.extract`, `requirements.analyze_conflicts`, `requirements.analyze_gaps`, `requirements.embed` |
| `ObjectStorage` | | Files |

## 11. Events & workflow integration
- **Emits:**
  - `requirement.snapshot.ingested`
  - `requirement.extraction.completed`
  - `requirement.version.created`
  - `requirement.version.submitted`
  - `requirement.version.approved`
  - `requirement.version.superseded`
  - `requirement.finding.created`
  - `requirement.impact.detected`
- **Class E:**
  - `sync.poll` (Azure)
  - `document.parse`
  - `requirements.extract`
  - `requirements.embed`
  - `requirements.reanalyze` (`key_strict_fifo` per requirement)
  - `impact.compute`
- **Class O (n8n):**
  - "Requirements updated → notify QA Lead"
  - "Approved requirements → request test plan generation" (calls the Automation API to create an AI test-suggestion job; the user still reviews the result)

## 12. Security requirements
- Uploads:
  - extension allowlist plus magic-byte verification
  - size limit
  - rejection of encrypted or password-protected files with a clear message
  - zip-bomb protection for DOCX/XLSX (an entry-count and expanded-size cap)
- The parser runs isolated ([ADR-0013](../adr/ADR-0013-python-parser-sidecar.md)).
- Document text sent to AI is redacted per project rules (emails, phone numbers, IDs, custom regexes).
- Document content is treated as **untrusted data** in prompts (prompt-injection defense, [15 §8](../15-ai-agent-architecture.md)).
- Rendered HTML of DOCX is sanitized (DOMPurify-equivalent, server-side) before display.

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| Scanned PDF with poor OCR | Blocks flagged low-confidence; whole snapshot gets `extraction_quality=low` banner; manual review forced |
| Unsupported structure (images of tables, SmartArt) | Block type `unsupported_visual` with page reference; user can add manual items linked to that locator |
| Parser timeout/crash | Snapshot `parse_failed` with error class; retry once with OCR disabled/enabled toggled; then manual-only |
| Malformed/corrupt file | Rejected at validation with reason; nothing stored except audit |
| Azure WIQL returns >20k items | Paged; first sync runs as background with progress; UI usable meanwhile |
| AI extraction returns invalid JSON | Repair retry (1), then fall back to deterministic extraction only; finding logged |
| Mixed-language paragraph | Language `mixed`; direction auto per Unicode bidi; search indexes both normalizations |

## 14. Edge cases
- The same PDF uploaded twice: checksum match, so no new snapshot, and the user is informed.
- A document series reordered: requirements are matched by stable ID if present in the text (e.g. "REQ-12"), otherwise by similarity plus locator heuristics ([14 §6](../14-requirements-engine.md)).
- An Azure item whose type changes (Task → User Story): it stays mapped and the type is updated.
- A deleted Azure item: `source_removed`.
- Excel with merged cells: the value propagates to the merged range, with a warning.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M04-AC-01 | A project with three sources (mock Azure Boards, one DOCX, one XLSX) produces one unified requirement list. Each requirement shows its source(s) and a working locator link. |
| M04-AC-02 | An inferred acceptance criterion cannot be approved by bulk-approve unless the "includes inferred" confirmation is given, and the audit records it. |
| M04-AC-03 | Updating an approved Azure work item (mock) creates a new draft version. The approved version remains effective, and linked tests are flagged `needs_review`. |
| M04-AC-04 | Uploading v2 of a PDF shows a diff with added, changed, and removed requirements, and lists every affected test case. |
| M04-AC-05 | A conflict between two sources blocks approval of both requirements until it is resolved or waived. |
| M04-AC-06 | An Arabic DOCX is parsed with correct RTL rendering in the review UI, and searching "الدخول" finds a requirement containing "الدُّخول" (diacritics-insensitive). |
| M04-AC-07 | A scanned PDF yields blocks with OCR confidence, and items below the threshold are excluded from bulk-accept. |
| M04-AC-08 | Uploading a password-protected PDF or a disguised executable is rejected, and nothing is passed to the parser. |
| M04-AC-09 | Downstream test design (M05) behaves identically for requirements from Azure, PDF, XLSX, and manual sources (same E2E scenario run four times). |
| M04-AC-10 | The duplicate suggestion between a story and a PDF item at similarity ≥ threshold can be merged, and the merged requirement keeps both provenances. |

## 16. Implementation tasks
**P3:**
- T-P3-01 (requirements aggregate + versions + AC)
- T-P3-02 (sources CRUD)
- T-P3-03 (manual entry UI/API)
- T-P3-04 (upload + validation + storage)
- T-P3-05 (parser service integration + ParsedDocument contract)
- T-P3-06 (deterministic extraction)
- T-P3-07 (spreadsheet column mapping)
- T-P3-08 (extraction review workspace UI)
- T-P3-09 (approval workflow + policy hook)
- T-P3-10 (Azure Boards RequirementsSource adapter + WIQL sync)
- T-P3-11 (snapshot diffing)
- T-P3-12 (traceability links base + requirement trace view)
- T-P3-13 (Arabic normalization + search)
- T-P3-14 (source viewer: PDF render, DOCX sanitized HTML, sheet grid)
- T-P3-15 (requirements list/detail UI)
- T-P3-16 (export)

**P5:**
- T-P5-20 (AI extraction assist)
- T-P5-21 (embeddings + duplicates)
- T-P5-22 (conflict analysis)
- T-P5-23 (gap/ambiguity analysis)
- T-P5-24 (findings inbox UI)
- T-P5-25 (impact analysis + `tests.suggest_updates`)

## 17. Testing requirements
- Parser contract tests on a **curated corpus** (30 files: EN/AR, DOCX/PDF/scanned/XLSX, tables, malformed) with golden outputs.
- Extraction precision/recall measured per release ([14 §7](../14-requirements-engine.md)).
- Diff tests (synthetic version pairs).
- Azure adapter recorded fixtures.
- AI eval datasets for extraction, conflicts, and gaps ([15 §10](../15-ai-agent-architecture.md)).

## 18. Dependencies & technical risks
Depends on M03, the parser (P0 spike), M14 (approval policies), and AI Gateway (P5).

| Risk | Mitigation |
|---|---|
| Extraction quality on Arabic/scanned docs | Spike T-P0-01, confidence gating, manual fallback |
| Over-flagging conflicts | Precision tracked; threshold tuning; easy dismissal with feedback captured as eval data |
