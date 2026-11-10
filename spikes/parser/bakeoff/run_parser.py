"""Run ONE parser on ONE file and write a common JSON (called in a subprocess with a timeout by bakeoff.py).

Common output: {parser, file, ok, error, seconds, pages, blocks:[{text, page, kind, table, row, col}]}
"""
import json, os, sys, time, traceback
from pathlib import Path


def docling_blocks(path: Path, ocr_langs, backend=None):
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, OcrAutoOptions
    opts = PdfPipelineOptions(do_ocr=True, do_table_structure=True)
    opts.ocr_options = OcrAutoOptions()  # docling picks the installed engine (RapidOCR on this host)
    kw = {"backend": backend} if backend else {}
    conv = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts, **kw)})
    doc = conv.convert(str(path)).document
    blocks = []
    for item, _ in doc.iterate_items():
        page = item.prov[0].page_no if getattr(item, "prov", None) else None
        if item.__class__.__name__ == "TableItem":
            for i, cell in enumerate(item.data.table_cells):
                blocks.append({"text": cell.text, "page": page, "kind": "cell", "table": id(item) % 10**6,
                               "row": cell.start_row_offset_idx, "col": cell.start_col_offset_idx})
        elif hasattr(item, "text"):
            blocks.append({"text": item.text, "page": page, "kind": getattr(item, "label", "text").__str__()})
    pages = len(doc.pages) if getattr(doc, "pages", None) else None
    return blocks, pages


def pdfplumber_blocks(path: Path, _langs):
    import pdfplumber
    blocks = []
    with pdfplumber.open(str(path)) as pdf:
        for pno, page in enumerate(pdf.pages, 1):
            for t_i, table in enumerate(page.extract_tables()):
                for r, row in enumerate(table):
                    for c, cell in enumerate(row):
                        if cell: blocks.append({"text": cell, "page": pno, "kind": "cell", "table": pno * 100 + t_i, "row": r, "col": c})
            for line in (page.extract_text() or "").splitlines():
                blocks.append({"text": line, "page": pno, "kind": "line"})
        return blocks, len(pdf.pages)


def pdfium_blocks(path, _langs):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(path)); blocks = []
    for pno, page in enumerate(doc, 1):
        for line in page.get_textpage().get_text_range().splitlines():
            if line.strip(): blocks.append({"text": line, "page": pno, "kind": "line"})
    return blocks, len(doc)


def docling_pdfium_blocks(path, langs):
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    return docling_blocks(path, langs, PyPdfiumDocumentBackend)


PARSERS = {"docling_pdfium": docling_pdfium_blocks, "docling": docling_blocks, "pdfplumber": pdfplumber_blocks, "pdfium": pdfium_blocks}

if __name__ == "__main__":
    parser, src, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    langs = sys.argv[4].split(",") if len(sys.argv) > 4 else ["en"]
    t0 = time.time(); res = {"parser": parser, "file": src.name}
    try:
        blocks, pages = PARSERS[parser](src, langs)
        res.update(ok=True, blocks=blocks, pages=pages)
    except Exception as e:  # graceful failure is the expected outcome for hostile files
        res.update(ok=False, error=f"{type(e).__name__}: {str(e)[:300]}", trace=traceback.format_exc()[-1500:])
    res["seconds"] = round(time.time() - t0, 2)
    out.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
