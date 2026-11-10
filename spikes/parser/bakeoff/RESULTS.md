# T-P0-01 — Parser bake-off, host run (no Docker) — 2026-11-09

**Scope of this run:**
- Docling 2.149.0 (torch 2.15.0 CPU, RapidOCR 3.10 for OCR) and pdfplumber 0.11.10 (PDF-only baseline)
- Python 3.14 on the Windows host
- 24 valid corpus files plus 4 hostile files

Tika+Tesseract and unstructured need a Python 3.12 / Java container, so they **wait for Docker**. The 2 Arabic scans were added and tested on 2026-11-10 (finding 6), as was PDFium (finding 8).

**What is scored:** *parser fidelity*. For each gold requirement and acceptance criterion: does its text survive extraction, is it on the right page, and is it in the right table row? Requirement-extraction rules are scored later, in P3 (T-P3-06).
- **Exact:** the token sequence matches after Arabic normalization.
- **Fuzzy:** at least 90% of tokens are present in a window. This tolerates visual word order.

Harness: `bakeoff.py`, `run_parser.py` (one subprocess per file, 600 s timeout), `textnorm.py`, `validate_upload.py`, `rtlfix.py`.

## Upload pre-validation (prototype of doc 21 §8)
All 4 hostile files are rejected **before** any parser sees them. All 24 valid files are accepted.
| File | Reason |
|---|---|
| m27 truncated PDF | `corrupt_or_truncated_pdf` |
| m28 encrypted PDF | `encrypted_pdf` |
| m29 zip-bomb DOCX (597 KB → 600 MB) | `zip_bomb_suspected` (from declared sizes; the parser still needs a streaming cap) |
| m30 MZ header named .pdf | `magic_bytes_mismatch` |

## Fidelity results
| Parser | Group | Files ok | Req exact | Req fuzzy | AC exact | AC fuzzy | Page locator | Table rows intact |
|---|---|---|---|---|---|---|---|---|
| docling | DOCX EN | 4/4 | 22/22 | 22/22 | 27/27 | 27/27 | – | 6/6 |
| docling | DOCX AR (+mixed) | 4/4 | 27/27 | 27/27 | 32/32 | 32/32 | – | 6/6 |
| docling | XLSX EN / AR | 3/3 | 17/17 | 17/17 | 22/22 | 22/22 | – | – |
| docling | CSV EN / AR | 2/2 | 10/10 | 10/10 | 10/10 | 10/10 | – | – |
| docling | PDF EN | 4/4 | 22/22 | 22/22 | 26/26 | 26/26 | 21/22 | 6/6 |
| docling | **PDF AR** | 4/4 | **12/21** | 20/21 | **5/24** | **10/24** | 20/20 | 4/5 |
| docling + PDF-only RTL cell fix | PDF AR | 4/4 | 15/21 | 20/21 | 7/24 | 10/24 | 20/20 | 4/5 |
| docling | Scanned EN (RapidOCR) | 3/3 | 11/16 | 12/16 | 13/19 | 14/19 | 12/12 | n/a¹ |
| pdfplumber | PDF EN | 4/4 | 22/22 | 22/22 | 26/26 | 26/26 | 21/22 | 6/6 |
| pdfplumber | PDF AR | 4/4 | 0/21 | 2/21 | 0/24 | 3/24 | – | 0/5 |
| pdfplumber | Scanned EN | 3/3 | 0/16 | 0/16 | 0/19 | 0/19 | – | – |
| pdfium (pypdfium2 raw text, added 2026-11-10) | PDF EN | 4/4 | 22/22 | 22/22 | 26/26 | 26/26 | 21/22 | 0/6 (no tables) |
| docling with its `PyPdfiumDocumentBackend` (2026-11-10) | PDF AR | 4/4 | 5/21 | 12/21 | 5/24 | 6/24 | 12/12 | 2/5 |
| pdfium | **PDF AR** | 4/4 | **17/21** | 20/21 | **20/24** | **23/24** | 20/20 | 0/5 (no tables) |

¹ The scanned "table" document draws its rows as `|`-separated text rather than a grid, so the row metric doesn't apply. The corpus generator should draw real table borders for scans (follow-up).

## Findings
1. **Docling is very good on DOCX, XLSX, CSV and English PDFs, in both languages.** It got 100% of text exact, kept tables intact, and 21 of 22 page locators were correct (the one miss is a requirement that straddles a page break).
2. **Arabic PDFs are the weak spot.** There are two separate defects:
   - **Diacritics split words.** A letter carrying a haraka/tanween is cut off and reordered within the line: `تُظهر` comes out as `ت … ُظهر`, and `حرفاً` as `حرفا … ً`. This explains almost all of the acceptance-criteria misses (each miss lacks exactly one such word).
   - **Table cells come out in visual (reversed) word order.** Reversing RTL cells fixes this only for PDFs. Applying the same fix to DOCX/XLSX breaks them, because those are already in logical order. So the fix must be **format-aware** and belongs in the `DocumentParser` adapter.
3. **pdfplumber is unusable for Arabic** (visual order, near zero recall) and does no OCR. It isn't a candidate.
4. **OCR models download at runtime** from `modelscope.cn`. The first two scanned files failed on that download and succeeded once the models were cached. This conflicts with the parser's no-egress rule (ADR-0013). **The parser image must bundle the OCR and layout models at build time, with checksums**, and run offline.
5. **Performance on CPU:** ~20–25 s for a 1-page PDF and ~29 s for 4 pages, so most of the time is per-process model loading. Office and sheet files take ~3–7 s. Scans take 47–63 s per page with RapidOCR.
   - NFR-PERF-05 (50-page digital PDF ≤ 60 s) can only be met by a **long-running parser process** with warm models (the design in ADR-0013). This needs measuring in Docker with a warm service.
6. **Arabic OCR works at word level with EasyOCR** (`ar+en`, CPU, tested 2026-11-10 on the 2 Arabic scans, `ocr_ar.py`). Word recall is 183/190 (96%), mean confidence 0.68, about 22 s per one-page file. RapidOCR's default models are Latin/Chinese and are not usable for Arabic.
   - **Reading order must be rebuilt right-to-left.** In EasyOCR's default box order only 3/10 requirements match in sequence; after grouping boxes into lines and reading each line right to left, 9/10 requirements and 6/11 acceptance criteria match (fuzzy ≥ 0.9).
   - The remaining AC misses are single misread words. Scanned Arabic stays low-confidence and review-forced.
   - The 200 MB Arabic model download broke once mid-transfer; another reason to bake models into the image (finding 4).
7. **Footprint:** Docling plus torch adds a multi-GB virtualenv, plus model caches (kept on D: here). The production parser image will be large, and image size should be budgeted.

8. **PDFium's text layer is much better on Arabic PDFs than Docling's default PDF backend** (added 2026-11-10). Raw `pypdfium2` text gets AC exact 20/24 against Docling's 5/24, and requirement exact 17/21 against 12/21, in under 1 s per file. It returns lines only, with no table structure. So the Arabic-PDF defect sits in the PDF text backend, not in the files.
   - **Switching Docling to its own pypdfium2 backend does not help; it is worse** (req exact 5/21, AC fuzzy 6/24, tables 2/5). Docling takes per-cell text from that backend, which loses word order. The gain comes only from PDFium's whole-page text range.

## Provisional decision (OD-02 stays open until the Docker run)
- **Docling is the primary parser** for DOCX/XLSX/CSV/PDF, with a format-aware RTL post-processor in the adapter.
- **Arabic PDFs:** take text from PDFium (finding 8) and keep Docling for layout and tables. Docling's own pypdfium2 backend was tried and rejected (finding 8). So the adapter runs both: Docling for structure and page locators, PDFium page text as the Arabic text of record, matched line to block. This merge is a P3 task (T-P3-06 scope) and is not yet built. Tika and poppler remain an optional comparison in Docker.
- **Arabic OCR:** EasyOCR `ar+en` with an RTL line-ordering step is the working baseline (finding 6). Tesseract `ara+eng` is an optional comparison in Docker.
- **Product impact, already reflected in docs 14 and 36:**
  - Arabic-PDF requirements get lower extraction confidence and forced review.
  - When the same document exists as DOCX, the DOCX is preferred.
