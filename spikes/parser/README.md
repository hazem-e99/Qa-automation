# T-P0-01 — Parser bake-off

## Corpus (generated 2026-11-09)
Synthetic EN/AR requirement documents with **exact gold annotations**, generated from `corpus/data.py` by `corpus/generate.py`. Only synthetic content is used, with no personal or company data.

```bash
py -3.14 -m venv .venv
.venv/Scripts/python.exe -m pip install python-docx==1.2.0 openpyxl==3.1.5 fpdf2==2.9.0 uharfbuzz==0.57.0
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe corpus/generate.py
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe corpus/verify.py
```

| Group | Files | Notes |
|---|---|---|
| DOCX | d01–d08 (4 EN, 3 AR, 1 mixed AR+EN) | Variants: numbered `REQ-n` + AC bullets, table (`FR-n` with AC column), numbered sections + "Then …" AC lines, prose without IDs (AC introduced by "For example,"). Arabic uses `w:bidi`/`w:rtl` and a `bidiVisual` table |
| Digital PDF | p09–p16 (4 EN, 4 AR) | fpdf2 with HarfBuzz shaping, RTL alignment, right-to-left table column order. `p12` is 4 pages, so requirements appear on pages 3–4 |
| Scanned PDF | s17–s19 (EN) | Image-only pages rendered at 150 dpi, with ±0.8° rotation, blur and speckle noise |
| Scanned PDF (AR) | s20–s21 | **Pending.** Generated inside the parser container by rendering p13/p16 to images (Pillow on the host has no libraqm, so it cannot shape Arabic) |
| Spreadsheets | x22–x24 XLSX (x23 RTL sheet, x24 merged "Module" column), c25–c26 CSV (UTF-8 BOM) | |
| Hostile/malformed | m27 truncated PDF, m28 encrypted PDF, m29 zip bomb DOCX (597 KB → 600 MB), m30 MZ header disguised as PDF | Expected outcome: rejected with a reason, never crashing |

- `corpus/manifest.json` lists every file with its expected handling and deliberate cross-document conflicts (auth password 8 vs 12 characters; booking cancellation 48 vs 24 hours).
- Gold is per file in `corpus/gold/*.json`: requirement text, AC, ID, page or row.
- `verify.py` confirms that every gold string is present verbatim in DOCX/XLSX/CSV (0 problems).

## Early finding (relevant to scoring and to doc 14 §5)
The text layer of a correctly shaped Arabic PDF does **not** extract as logical-order text:
- The lam-alef ligature comes back as `اإلجازة` instead of `الإجازة`.
- Neutral and LTR tokens inside RTL runs get reordered, so `FR-2` comes back as `-2FR`.

Consequences:
- **Bake-off scoring** cannot use exact substring matching for PDFs. It uses normalized matching instead: Arabic normalization from 14 §8, lam-alef recomposition, and token-set comparison for mixed-direction IDs.
- **The quote-grounding validator** (15 §4) must apply the same normalization, or it will wrongly drop valid Arabic extractions.
- **The parser candidates** are evaluated on whether they fix this themselves. Docling, Tika and unstructured each handle it differently.

## Next (needs Docker)
1. Build `parser-bakeoff` images (Python 3.12) for docling, unstructured, and Tika server + Tesseract `ara+eng`.
2. Generate s20/s21 in-container.
3. Run each parser over all 30 files and score against [14 §7](../../docs/planning/14-requirements-engine.md) targets: recall, precision, locator accuracy, AC recall, malformed handling, time per page.
