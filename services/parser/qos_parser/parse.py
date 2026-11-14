"""Document parsing for QualityOS (T-P3-05, ADR-0013, decision OD-02 from the P0 bake-off).

One function, ``parse(kind, path)``, returns a ``ParsedDocument`` dict: ordered blocks with a
locator (page, section path, paragraph index, sheet/table/row/column), a language per block and
an OCR confidence for scanned pages.

Engines, per the P0 results (spikes/parser/bakeoff/RESULTS.md):
- DOCX and digital PDF: Docling (structure, headings, lists, tables).
- Arabic-dominant digital PDF pages: PDFium's text layer, line by line (Docling's PDF text splits
  Arabic words with diacritics and reverses table cells).
- Scanned PDF pages (no text layer): EasyOCR ar+en, lines rebuilt right to left for Arabic.
- XLSX / CSV: openpyxl and the csv module (exact cells with sheet, row and column).
The caller validated the file already (magic bytes, encryption, ZIP bombs, size).
"""
from __future__ import annotations

import csv
import io
import re
from pathlib import Path
from typing import Any

PARSER_VERSION = "qos-parser/0.1.0"
MAX_PAGES = 300
AR = re.compile(r"[؀-ۿ]")
LATIN = re.compile(r"[A-Za-z]")


def language_of(text: str) -> str | None:
    ar, la = len(AR.findall(text)), len(LATIN.findall(text))
    if not ar and not la:
        return None
    if ar and la and min(ar, la) / max(ar, la) > 0.2:
        return "mixed"
    return "ar" if ar > la else "en"


_ARTICLE_LIGATURE = re.compile("ا([إأآ])ل")


def repair_lam_alef(text: str) -> str:
    """PDF text layers emit the ligature lam + hamza-alef in visual order after the article:
    "اإللكترونية" for "الإلكترونية". The broken sequence alef, hamza-alef, lam does not occur in
    correct Arabic, so it is swapped back. Plain lam-alef ("طلاب" vs "طالب") stays ambiguous and
    is left alone (P0 finding 2)."""
    return _ARTICLE_LIGATURE.sub(lambda m: "ال" + m.group(1), text)


class ParseError(Exception):
    """A document that cannot be parsed. ``code`` is stable and shown to users."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail[:300]


class _Builder:
    def __init__(self) -> None:
        self.blocks: list[dict[str, Any]] = []

    def add(self, type_: str, text: str, locator: dict[str, Any], level: int | None = None, ocr: float | None = None) -> None:
        text = (text or "").strip()
        if not text:
            return
        block: dict[str, Any] = {
            "id": f"b{len(self.blocks) + 1}",
            "type": type_,
            "text": text,
            "locator": {k: v for k, v in locator.items() if v is not None},
            "language": language_of(text),
        }
        if level is not None:
            block["level"] = level
        if ocr is not None:
            block["ocrConfidence"] = round(float(ocr), 3)
        self.blocks.append(block)


def _result(kind: str, b: _Builder, pages: int | None, ocr_pages: int = 0) -> dict[str, Any]:
    langs = sorted({x["language"] for x in b.blocks if x["language"] in ("ar", "en")} |
                   ({"ar", "en"} if any(x["language"] == "mixed" for x in b.blocks) else set()))
    return {"parserVersion": PARSER_VERSION, "kind": kind, "pages": pages, "languages": langs, "ocrPages": ocr_pages, "blocks": b.blocks}


# ---------- spreadsheets ----------

def _sheet_rows(rows: list[list[Any]], sheet: str, b: _Builder) -> None:
    for r, row in enumerate(rows, start=1):
        for c, value in enumerate(row, start=1):
            if value is None or str(value).strip() == "":
                continue
            b.add("table_cell", str(value), {"sheet": sheet, "row": r, "col": c})


def parse_xlsx(path: Path) -> dict[str, Any]:
    import openpyxl

    wb = openpyxl.load_workbook(str(path), data_only=True)  # not read_only: merged ranges are needed
    b = _Builder()
    for ws in wb.worksheets:
        grid = [[cell.value for cell in row] for row in ws.iter_rows()]
        # A merged range shows its value in every cell it covers (e.g. a merged "Module" column).
        for rng in ws.merged_cells.ranges:
            top = ws.cell(rng.min_row, rng.min_col).value
            for r in range(rng.min_row, rng.max_row + 1):
                for c in range(rng.min_col, rng.max_col + 1):
                    if r - 1 < len(grid) and c - 1 < len(grid[r - 1]):
                        grid[r - 1][c - 1] = top
        _sheet_rows(grid, ws.title, b)
    return _result("xlsx", b, None)


def parse_csv(path: Path) -> dict[str, Any]:
    text = path.read_bytes().decode("utf-8-sig")
    dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t") if text.strip() else csv.excel
    rows = list(csv.reader(io.StringIO(text), dialect))
    b = _Builder()
    _sheet_rows(rows, "csv", b)
    return _result("csv", b, None)


# ---------- DOCX and PDF through Docling ----------

def _docling_items(path: Path, pdf: bool):
    from docling.datamodel.base_models import InputFormat
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = {}
    if pdf:
        from docling.datamodel.pipeline_options import PdfPipelineOptions

        opts = PdfPipelineOptions(do_ocr=False, do_table_structure=True)  # OCR is done separately
        options = {InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    doc = DocumentConverter(format_options=options).convert(str(path)).document
    return doc


def _walk_docling(doc, b: _Builder, skip_pages: set[int] = frozenset()) -> None:
    sections: list[str] = []
    paragraph = 0
    table_no = 0
    for item, _level in doc.iterate_items():
        page = item.prov[0].page_no if getattr(item, "prov", None) else None
        if page in skip_pages:
            continue
        label = str(getattr(item, "label", "text")).split(".")[-1].lower()
        if item.__class__.__name__ == "TableItem":
            table_no += 1
            for cell in item.data.table_cells:
                b.add("table_cell", cell.text, {"page": page, "sectionPath": list(sections) or None, "table": table_no,
                                                "row": cell.start_row_offset_idx + 1, "col": cell.start_col_offset_idx + 1})
            continue
        text = getattr(item, "text", None)
        if not text:
            continue
        if label in ("title", "section_header"):
            level = int(getattr(item, "level", 1) or 1)
            sections = sections[: max(0, level - 1)] + [text.strip()[:200]]
            b.add("heading", text, {"page": page, "sectionPath": list(sections)}, level=level)
        else:
            paragraph += 1
            b.add("list_item" if label == "list_item" else "paragraph", text,
                  {"page": page, "sectionPath": list(sections) or None, "paragraph": paragraph})


def parse_docx(path: Path) -> dict[str, Any]:
    b = _Builder()
    _walk_docling(_docling_items(path, pdf=False), b)
    return _result("docx", b, None)


def _ocr_page(page, reader) -> list[tuple[str, float]]:
    """EasyOCR boxes grouped into lines by y; Arabic lines read right to left (P0 finding 6)."""
    import numpy as np

    img = np.array(page.render(scale=2).to_pil().convert("RGB"))
    res = sorted(reader.readtext(img, paragraph=False), key=lambda r: min(p[1] for p in r[0]))
    lines: list[list[Any]] = []
    for r in res:
        y0 = min(p[1] for p in r[0])
        h = max(p[1] for p in r[0]) - y0
        if lines and abs(lines[-1][0] - y0) < 0.6 * h:
            lines[-1][1].append(r)
        else:
            lines.append([y0, [r]])
    out = []
    for _, boxes in lines:
        rtl = sum(len(AR.findall(t)) for _, t, _ in boxes) > sum(len(LATIN.findall(t)) for _, t, _ in boxes)
        ordered = sorted(boxes, key=lambda r: (-1 if rtl else 1) * max(p[0] for p in r[0]))
        out.append((" ".join(t for _, t, _ in ordered), sum(c for _, _, c in ordered) / len(ordered)))
    return out


_READER = None


def _easyocr():
    global _READER
    if _READER is None:
        import os

        import easyocr

        _READER = easyocr.Reader(["ar", "en"], gpu=False, download_enabled=os.environ.get("QOS_OCR_DOWNLOAD") == "1",
                                 model_storage_directory=os.environ.get("QOS_OCR_MODELS") or None)
    return _READER


def parse_pdf(path: Path) -> dict[str, Any]:
    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(str(path))
    except pdfium.PdfiumError as e:
        raise ParseError("pdf_unreadable", str(e)) from e
    n = len(pdf)
    if n > MAX_PAGES:
        raise ParseError("too_many_pages", f"{n} pages")
    texts = [page.get_textpage().get_text_range() for page in pdf]
    scanned = {i + 1 for i, t in enumerate(texts) if len(t.strip()) < 20}
    arabic = {i + 1 for i, t in enumerate(texts) if i + 1 not in scanned and language_of(t) == "ar"}
    b = _Builder()
    if len(scanned | arabic) < n:
        _walk_docling(_docling_items(path, pdf=True), b, skip_pages=scanned | arabic)
    # Arabic pages: PDFium text lines in logical order, with the lam-alef ligature repaired.
    for pno in sorted(arabic):
        for i, line in enumerate(l for l in texts[pno - 1].splitlines() if l.strip()):
            b.add("paragraph", repair_lam_alef(line), {"page": pno, "line": i + 1})
    for pno in sorted(scanned):
        for i, (line, conf) in enumerate(_ocr_page(pdf[pno - 1], _easyocr())):
            b.add("paragraph", line, {"page": pno, "line": i + 1}, ocr=conf)
    b.blocks.sort(key=lambda x: (x["locator"].get("page", 0), int(x["id"][1:])))
    for i, x in enumerate(b.blocks, start=1):
        x["id"] = f"b{i}"
    return _result("pdf", b, n, len(scanned))


PARSERS = {"pdf": parse_pdf, "docx": parse_docx, "xlsx": parse_xlsx, "csv": parse_csv}


def parse(kind: str, path: Path) -> dict[str, Any]:
    if kind not in PARSERS:
        raise ParseError("unsupported_type", kind)
    try:
        return PARSERS[kind](path)
    except ParseError:
        raise
    except Exception as e:  # malformed documents fail with a reason, never a crash (doc 14 §7)
        raise ParseError("parse_failed", f"{type(e).__name__}: {e}") from e
