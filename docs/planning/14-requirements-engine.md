# 14 — Requirements Engine

> Status: **Planned** · Owner: Backend + AI Engineer · Module: [M04](modules/M04-requirements-intelligence.md) · Parser: [ADR-0013](adr/ADR-0013-python-parser-sidecar.md)

## 1. Design goal
Use one normalized requirements model for every source, so the downstream QA workflow is identical whether a requirement came from Azure Boards, PDF, Word, Excel, or manual entry. A single project can combine several sources.

## 2. Pipeline
```mermaid
flowchart TB
  subgraph Ingest
    A1[Azure Boards sync<br/>WIQL + ChangedDate] --> S
    A2[Upload DOCX/PDF] --> V[Validate: magic bytes, size,<br/>encryption, zip-bomb caps] --> ST[(Object storage)] --> S
    A3[Upload XLSX/CSV] --> V
    A4[Manual entry] --> S
    S[SourceSnapshot<br/>immutable · checksum · externalVersion]
  end
  subgraph Extract
    S -->|documents| P[parser sidecar → ParsedDocument<br/>blocks + locators + language + OCR conf]
    P --> DX[Deterministic extraction<br/>headings, numbering, modal verbs,<br/>tables, AC patterns]
    DX --> AX[AI-assisted extraction (P5)<br/>requirements.extract]
    S -->|work items / rows / manual| FM[Field mapping → items]
    AX & FM & DX --> EI[ExtractedItems<br/>kind · text · locator · confidence · method]
  end
  subgraph Normalize
    EI --> MT[Match to existing requirements<br/>stable IDs → external id → similarity]
    MT --> RV[New RequirementVersion (draft)<br/>+ AC (origin source/inferred)<br/>+ provenance links]
  end
  subgraph Analyze (P5)
    RV --> EMB[Embeddings]
    EMB --> DUP[Duplicate candidates]
    RV --> CON[Conflict analysis<br/>pairwise on topic clusters]
    RV --> GAP[Gap & ambiguity analysis]
    DUP & CON & GAP --> F[Findings (open)]
  end
  subgraph Govern
    RV & F --> REV[Human review UI]
    REV --> APP{Approval policy}
    APP -->|approved| EFF[Effective version<br/>→ downstream QA]
    EFF --> IMP[Impact analysis vs previous effective<br/>→ tests needs_review]
  end
```

## 3. Canonical model (summary)
- **`SourceItem`** (from adapters): `{externalId, revision, type, title, body, acText?, state, tags, links, attachments, url, changedAt}`
- **`ParsedDocument`** (from the parser):
```json
{
  "parserVersion": "x.y", "pages": 12, "languages": ["en","ar"],
  "blocks": [
    {"id":"b17","type":"heading|paragraph|list_item|table_cell|caption|image|unsupported_visual",
     "text":"…","level":2,"sectionPath":["3","3.2"],"page":4,"bbox":[x,y,w,h],
     "table":{"tableId":"t3","row":5,"col":2,"header":"Acceptance Criteria"},
     "lang":"ar","direction":"rtl","ocr":{"used":true,"confidence":0.81}}
  ],
  "warnings":[{"code":"merged_cells","page":6}]
}
```
- **`ExtractedItem`**: `{kind: requirement|ac|context|unsupported_visual, text, locator, language, confidence, method, parentItemId?}`
- **`Requirement` / `RequirementVersion` / `AcceptanceCriterion`**: see [09 §3.1](09-domain-model.md).

## 4. Deterministic extraction rules (structure first)
1. **Explicit IDs.** Patterns such as `REQ-12`, `FR-3.2`, `US-45`, and Arabic-numbered equivalents become stable matching keys.
2. **Modal verbs.**
   - English: *shall, must, should, will, is required to*.
   - Arabic: *يجب، ينبغي، يلزم، على النظام أن*.
   - A sentence-level match is a requirement candidate. Confidence is 0.7 by default, and rises to 0.85 when the sentence sits under a "Requirements" heading.
3. **AC patterns.** "Given/When/Then", "Acceptance criteria:" headings, bullet lists under AC headings, and table columns named *Acceptance Criteria / معايير القبول*.
4. **Tables.** A table header row that maps to ID/Title/Description/AC/Priority becomes row-wise items. Spreadsheet mappings reuse the same logic.
5. **Context blocks.** Definitions, glossary entries, and non-requirement prose become `context` items, kept for AI prompts.
6. **Unsupported visuals.** Images, SmartArt, and charts become `unsupported_visual` blocks that reference their page and stay visible in review.

## 5. AI-assisted extraction (P5)
- **Task:** `requirements.extract@v1` ([15 §5](15-ai-agent-architecture.md)).
- **Input:** a section-sized chunk of blocks (≤ 6k tokens) plus context items plus project glossary.
- **Output:** a list of candidates. Each candidate must cite `sourceBlockIds[]` and give the verbatim `quote`. The gateway checks that every quote occurs as a substring of the referenced blocks after normalization. Candidates that fail the check are dropped.
- **No invention.** The model may propose `inferredAcceptanceCriteria[]` *separately*, and those are stored with `origin=inferred`, low trust, and need explicit approval.
- **Merging with deterministic output.** Both outputs are merged and deduplicated by quote overlap. AI-only candidates are capped at confidence 0.75 unless deterministic signals agree.

## 6. Matching new snapshots to existing requirements
Matching happens in this order:
1. **External ID.** Azure work item ID, or a spreadsheet ID column. This match is exact.
2. **Explicit document IDs** (`REQ-12`). Exact.
3. **Locator continuity plus similarity.** Same section path and cosine similarity ≥ 0.92 counts as a match ("changed" if text differs). Similarity in [0.80, 0.92) becomes a "possible match" that a reviewer confirms in the diff UI.
4. **No match.** The candidate becomes a new requirement candidate.

Previous approved requirements whose source item has no match are marked `source_removed`.

## 7. Quality targets and measurement
These targets are measured on the curated corpus (`fixtures/documents`, 30 files: 15 EN and 15 AR, including 5 scanned PDFs, 5 XLSX, and 3 malformed files).

| Metric | Target (digital docs) | Target (scanned) |
|---|---|---|
| Requirement candidate recall | ≥ 0.90 | ≥ 0.75 |
| Requirement candidate precision | ≥ 0.85 | ≥ 0.70 |
| Locator accuracy (page + section correct) | ≥ 0.98 | ≥ 0.90 |
| AC extraction recall (where AC explicitly present) | ≥ 0.90 | ≥ 0.70 |
| Invented requirement rate (candidates with no supporting quote) | **0** (enforced by quote validation) | 0 |
| Malformed file handling | 100% rejected or flagged with reason; no crash | — |

Spike T-P0-01 chooses the parser by these metrics. Regression runs in CI on every parser or prompt change.

## 8. Arabic and bilingual handling
- **Language and direction.** Language is detected per block (script ratio plus a lightweight detector). Direction comes from the first strong character, and is overridden by the block's language when the block mixes scripts.
- **Normalization for search, matching, and embeddings** (the original text is never altered):
  - Strip diacritics (tashkeel) and tatweel.
  - Unify alef forms (أ إ آ ا → ا).
  - Ya and alef maqsura (ى → ي).
  - Ta marbuta (ة → ه) for matching only.
  - Normalize Arabic-Indic digits (٠-٩ → 0-9) for ID patterns.
  - **PDF text layer repair** (found in T-P0-01): recompose split lam-alef sequences (e.g. extracted `اإل` → `الإ`), and compare mixed-direction tokens such as IDs as token sets, because `FR-2` can extract as `-2FR`. Grounding and matching use this normalized form.
- **Search.** Postgres full-text search with the `simple` config on normalized text, plus `pg_trgm` for fuzzy matching. Arabic stemming is out of scope for the pilot.
- **OCR.** Tesseract `ara+eng` with per-page confidence. Pages below 0.6 are flagged.
- **Rendering.** The review UI renders blocks with `dir="auto"`, and mirrors the layout for RTL-dominant documents.

## 9. Conflict, gap, duplicate analysis (P5)
| Analysis | Method | Output | Precision control |
|---|---|---|---|
| Duplicates | Embedding similarity ≥ 0.88 within project + same-topic heuristics; LLM judge optional for 0.80–0.88 band | `duplicate` finding with pair + score | Threshold tuned on eval set; reviewer dismissals logged |
| Conflicts | Topic clustering (embeddings) → candidate pairs in same cluster from **different sources or versions** → `requirements.analyze_conflicts@v1` returns `{conflict: bool, type: numeric|behavioral|scope|terminology, explanation, quotes[2]}` | `conflict` finding | Must quote both sides; precision target ≥ 0.80 on eval set |
| Gaps/ambiguity | `requirements.analyze_gaps@v1` per requirement: checklist (error handling, limits, roles/permissions, states, data validation, non-functional) + vague term lexicon EN/AR | `gap`/`ambiguity` findings with suggested clarifying questions and optional inferred AC | Suggestions only; never auto-applied |

Cost control: analysis runs on changed requirements only. Pairwise conflict checks are limited to topic clusters, giving roughly O(n·k) calls.

## 10. Change impact analysis
1. A snapshot diff is computed at the requirement level (added, changed, removed) and the AC level.
2. For each changed approved requirement, traverse `verifies` links to test case versions, then automation bindings, open defects, and active cycles.
3. Mark the test cases `needs_review`, and attach an impact record to the new draft requirement version.
4. Optionally run AI `tests.suggest_updates@v1`. It proposes edited steps or expected results, and new or retired tests, as suggestions in M05.
5. **Nothing changes automatically.** Approval of the new requirement version and of the test updates is human.

## 11. Limitations (documented, shown in UI)
- **Scanned PDFs:** accuracy depends on scan quality. Handwriting is not supported.
- **Visual content:** images of tables, diagrams, and screenshots of UI mock-ups are not interpreted, except optionally through the `ai.vision` task (future, cost-gated).
- **DOCX:** tracked changes are read as their *accepted* view. Comments are ignored, and the user is warned.
- **Merged cells** in tables propagate values with a warning. **Nested tables** are flattened.
- **Encrypted or password-protected files** are rejected.
- **Very large files** over 50 MB or 500 pages are rejected by default (configurable).
- **Mixed-language sentences** may be split oddly, and language detection on short blocks under 20 characters is unreliable.
- **Arabic PDFs** (measured in T-P0-01): letters carrying diacritics (harakat/tanween) can be split from their word and reordered, and RTL table cells may come out in visual (reversed) word order. Arabic-PDF candidates therefore get capped confidence and forced review. When the same document exists as DOCX, the UI recommends uploading the DOCX instead.
  - Mitigation measured on 2026-11-10: the PDFium page text layer keeps Arabic words intact far more often (AC exact 20/24 against 5/24). The `DocumentParser` adapter takes Arabic PDF text from PDFium and structure from the layout parser. The forced review stays.
- **Scanned Arabic** (measured 2026-11-10): OCR needs an Arabic model and a right-to-left line-ordering step. Word recall was 96% on the test scans, with single-word misreads in about half of the acceptance criteria. Always review-forced.
- **Azure Boards:** only fields in the mapping are read. Custom HTML formatting is reduced to Markdown.
