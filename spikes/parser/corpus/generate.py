"""Generate the T-P0-01 parser corpus (synthetic, EN/AR) plus exact gold annotations.

Usage (from spikes/parser):  .venv/Scripts/python.exe corpus/generate.py
Outputs: corpus/files/*, corpus/gold/*.json, corpus/manifest.json
Arabic scanned PDFs (s20, s21) are produced later inside the parser container (needs a PDF renderer).
"""
import csv, io, json, os, random, zipfile
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from fpdf import FPDF
from fpdf.enums import XPos, YPos
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from data import DOMAINS, CONFLICTS

ROOT = Path(__file__).parent
OUT, GOLD = ROOT / "files", ROOT / "gold"
OUT.mkdir(exist_ok=True); GOLD.mkdir(exist_ok=True)
FONT = r"C:\Windows\Fonts\arial.ttf"
FONT_B = r"C:\Windows\Fonts\arialbd.ttf"
random.seed(7)

L = {  # labels per language
    "en": {"ac": "Acceptance criteria:", "then": "Then ", "req_section": "Functional requirements", "intro": "Introduction",
           "cols": ["ID", "Requirement", "Acceptance Criteria", "Priority"], "prio": ["High", "Medium", "Low"],
           "eg": "For example, ", "module": "Module"},
    "ar": {"ac": "معايير القبول:", "then": "النتيجة المتوقعة: ", "req_section": "المتطلبات الوظيفية", "intro": "مقدمة",
           "cols": ["المعرف", "المتطلب", "معايير القبول", "الأولوية"], "prio": ["عالية", "متوسطة", "منخفضة"],
           "eg": "على سبيل المثال، ", "module": "الوحدة"},
}

# ---------------------------------------------------------------- block model
def blocks_for(domain, lang, variant, filler=0):
    """Return (blocks, gold_reqs). Block = dict(kind, text, ...). Gold text is verbatim in the document."""
    d = DOMAINS[domain][lang]; lab = L[lang]
    blocks = [{"kind": "title", "text": d["title"]}, {"kind": "heading", "text": "1. " + lab["intro"]}]
    blocks += [{"kind": "para", "text": t} for t in d["context"]]
    for _ in range(filler):  # extra context to force multiple pages
        blocks += [{"kind": "para", "text": " ".join(d["context"] * 3)}]
    blocks.append({"kind": "heading", "text": "2. " + lab["req_section"]})
    gold = []
    for i, (text, acs) in enumerate(d["reqs"], 1):
        g = {"text": text, "ac": list(acs), "lang": lang, "section": "2"}
        if variant == "numbered":
            rid = f"REQ-{i}"; g["id"] = rid
            blocks.append({"kind": "req", "text": f"{rid}: {text}", "gold": len(gold)})
            blocks.append({"kind": "para", "text": lab["ac"]})
            blocks += [{"kind": "bullet", "text": a} for a in acs]
        elif variant == "stories":
            g["section"] = f"2.{i}"
            blocks.append({"kind": "heading2", "text": f"2.{i} " + " ".join(text.split()[:5]) + " …"})
            blocks.append({"kind": "req", "text": text, "gold": len(gold)})
            blocks += [{"kind": "para", "text": lab["then"] + a} for a in acs]
        elif variant == "prose":
            ctx = d["context"][i % len(d["context"])]
            blocks.append({"kind": "req", "text": f"{ctx} {text} " + " ".join(lab["eg"] + a for a in acs), "gold": len(gold)})
        gold.append(g)
    if variant == "table":
        rows = []
        for i, (text, acs) in enumerate(d["reqs"], 1):
            rows.append([f"FR-{i}", text, "\n".join(acs), lab["prio"][i % 3]])
            gold[i - 1]["id"] = f"FR-{i}"
        blocks.append({"kind": "table", "header": lab["cols"], "rows": rows})
    return blocks, gold

# ---------------------------------------------------------------- DOCX
def set_rtl(paragraph):
    pPr = paragraph._p.get_or_add_pPr(); bidi = OxmlElement("w:bidi"); bidi.set(qn("w:val"), "1"); pPr.append(bidi)
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for r in paragraph.runs:
        rPr = r._r.get_or_add_rPr(); rtl = OxmlElement("w:rtl"); rtl.set(qn("w:val"), "1"); rPr.append(rtl)

def write_docx(path, blocks, lang):
    doc = Document()
    for b in blocks:
        k = b["kind"]
        if k == "title": p = doc.add_heading(b["text"], 0)
        elif k == "heading": p = doc.add_heading(b["text"], 1)
        elif k == "heading2": p = doc.add_heading(b["text"], 2)
        elif k == "bullet": p = doc.add_paragraph(b["text"], style="List Bullet")
        elif k == "table":
            hdr = b["header"][::-1] if lang == "ar" else b["header"]
            t = doc.add_table(rows=1, cols=len(hdr)); t.style = "Table Grid"
            for c, h in zip(t.rows[0].cells, hdr): c.text = h
            for row in b["rows"]:
                cells = t.add_row().cells
                for c, v in zip(cells, row[::-1] if lang == "ar" else row): c.text = v
            if lang == "ar":
                tblPr = t._tbl.tblPr; bv = OxmlElement("w:bidiVisual"); tblPr.append(bv)
            continue
        else: p = doc.add_paragraph(b["text"])
        if lang == "ar" or b.get("lang") == "ar": set_rtl(p)
    doc.save(path)

# ---------------------------------------------------------------- PDF (digital)
class PDF(FPDF):
    def __init__(self, lang):
        super().__init__(format="A4"); self.lang = lang
        self.add_font("Arial", "", FONT); self.add_font("Arial", "B", FONT_B)
        if lang == "ar": self.set_text_shaping(use_shaping_engine=True, direction="rtl", script="arab", language="ar")
        else: self.set_text_shaping(use_shaping_engine=True, direction="ltr")
        self.set_auto_page_break(True, 18); self.add_page()

    def para(self, text, size=11, style="", indent=0):
        self.set_font("Arial", style, size)
        align = "R" if self.lang == "ar" else "L"
        if indent:
            if self.lang == "ar": self.set_right_margin(10 + indent)
            else: self.set_left_margin(10 + indent)
            self.set_x(self.l_margin)
        self.multi_cell(0, 6, text, align=align, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_left_margin(10); self.set_right_margin(10); self.ln(1.5)

def write_pdf(path, blocks, gold, lang):
    pdf = PDF(lang)
    for b in blocks:
        k = b["kind"]
        if k == "title": pdf.para(b["text"], 16, "B")
        elif k == "heading": pdf.para(b["text"], 13, "B")
        elif k == "heading2": pdf.para(b["text"], 12, "B")
        elif k == "bullet": pdf.para("• " + b["text"], indent=6)
        elif k == "table":
            pdf.set_font("Arial", "", 9)
            hdr = b["header"][::-1] if lang == "ar" else b["header"]
            widths = (20, 70, 75, 25)[::-1] if lang == "ar" else (20, 70, 75, 25)
            start_page = pdf.page_no()
            with pdf.table(col_widths=widths, text_align="RIGHT" if lang == "ar" else "LEFT") as t:
                r = t.row(); [r.cell(h) for h in hdr]
                for gi, row in enumerate(b["rows"]):
                    r = t.row(); [r.cell(v) for v in (row[::-1] if lang == "ar" else row)]
                    gold[gi]["page"] = pdf.page_no()
            continue
        else:
            if k == "req": gold[b["gold"]]["page"] = pdf.page_no()
            pdf.para(b["text"])
    pdf.output(str(path))
    return pdf.page_no()

# ---------------------------------------------------------------- "scanned" PDF (EN only on host)
def write_scanned(path, blocks, gold):
    W, H, M = 1240, 1754, 90  # A4 @150 dpi
    font = ImageFont.truetype(FONT, 26); bold = ImageFont.truetype(FONT_B, 34)
    pages, img, draw, y = [], None, None, M

    def new_page():
        nonlocal img, draw, y
        if img is not None: pages.append(img)
        img = Image.new("L", (W, H), 255); draw = ImageDraw.Draw(img); y = M

    def lines(text, f, width):
        out, cur = [], ""
        for w in text.split():
            t = (cur + " " + w).strip()
            if draw.textlength(t, font=f) > width: out.append(cur); cur = w
            else: cur = t
        return out + [cur]

    new_page()
    for b in blocks:
        rows = []
        if b["kind"] == "table":
            rows = [" | ".join(b["header"])] + [" | ".join(r).replace("\n", "; ") for r in b["rows"]]
            for gi in range(len(b["rows"])): gold[gi]["page"] = len(pages) + 1
        else:
            rows = [("• " if b["kind"] == "bullet" else "") + b["text"]]
            if b["kind"] == "req": gold[b["gold"]]["page"] = len(pages) + 1
        f = bold if b["kind"] in ("title", "heading", "heading2") else font
        for r in rows:
            for ln in lines(r, f, W - 2 * M):
                if y > H - M: new_page()
                draw.text((M, y), ln, font=f, fill=0); y += int(f.size * 1.45)
            y += 8
    pages.append(img)
    pdf = FPDF(format="A4")
    for p in pages:  # simulate scanning: slight rotation, blur, speckle noise
        p = p.rotate(random.uniform(-0.8, 0.8), expand=False, fillcolor=255).filter(ImageFilter.GaussianBlur(0.6))
        px = p.load()
        for _ in range(4000): px[random.randrange(W), random.randrange(H)] = random.randrange(80, 200)
        buf = io.BytesIO(); p.save(buf, "PNG"); buf.seek(0)
        pdf.add_page(); pdf.image(buf, x=0, y=0, w=210, h=297)
    pdf.output(str(path))
    return len(pages)

# ---------------------------------------------------------------- XLSX / CSV
def sheet_rows(domain, lang):
    d = DOMAINS[domain][lang]; lab = L[lang]
    rows = [[f"FR-{i}", t, "\n".join(a), lab["prio"][i % 3]] for i, (t, a) in enumerate(d["reqs"], 1)]
    gold = [{"id": f"FR-{i}", "text": t, "ac": list(a), "lang": lang, "row": i + 1} for i, (t, a) in enumerate(d["reqs"], 1)]
    return lab["cols"], rows, gold

def write_xlsx(path, domain, lang, merged=False):
    hdr, rows, gold = sheet_rows(domain, lang)
    wb = Workbook(); ws = wb.active; ws.title = "Requirements"
    if lang == "ar": ws.sheet_view.rightToLeft = True
    if merged:
        hdr = [L[lang]["module"]] + hdr
        rows = [[DOMAINS[domain][lang]["title"].split("—")[0].strip()] + r for r in rows]
    ws.append(hdr)
    for c in ws[1]: c.font = Font(bold=True)
    for r in rows: ws.append(r)
    for row in ws.iter_rows(min_row=2):
        for c in row: c.alignment = Alignment(wrap_text=True, vertical="top")
    if merged:
        ws.merge_cells(start_row=2, start_column=1, end_row=len(rows) + 1, end_column=1)
        for g in gold: g["note"] = "module column is a merged cell spanning all rows"
    wb.save(path)
    return gold

def write_csv(path, domain, lang):
    hdr, rows, gold = sheet_rows(domain, lang)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f); w.writerow(hdr); w.writerows(rows)
    return gold

# ---------------------------------------------------------------- malformed
def write_zip_bomb(path, expanded_mb=600):
    ct = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="xml" ContentType="application/xml"/></Types>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("[Content_Types].xml", ct)
        with z.open("word/document.xml", "w", force_zip64=True) as f:
            f.write(b'<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>')
            chunk = b" " * (1024 * 1024)
            for _ in range(expanded_mb): f.write(chunk)
            f.write(b"</w:t></w:r></w:p></w:body></w:document>")

def write_encrypted(path):
    pdf = PDF("en"); pdf.para("Confidential requirements. The system shall encrypt data at rest.")
    pdf.set_encryption(owner_password="owner-spike", user_password="user-spike")
    pdf.output(str(path))

# ---------------------------------------------------------------- plan
PLAN = [
    # id, format, domain, lang, variant, extra
    ("d01", "docx", "checkout", "en", "numbered", {}), ("d02", "docx", "auth", "en", "table", {}),
    ("d03", "docx", "booking", "en", "stories", {}), ("d04", "docx", "leave", "en", "prose", {}),
    ("d05", "docx", "checkout", "ar", "numbered", {}), ("d06", "docx", "auth", "ar", "table", {}),
    ("d07", "docx", "booking", "ar", "stories", {}), ("d08", "docx", "library", "mixed", "numbered", {}),
    ("p09", "pdf", "library", "en", "numbered", {}), ("p10", "pdf", "checkout", "en", "table", {}),
    ("p11", "pdf", "leave", "en", "stories", {}), ("p12", "pdf", "auth", "en", "prose", {"filler": 30}),
    ("p13", "pdf", "library", "ar", "numbered", {}), ("p14", "pdf", "leave", "ar", "table", {}),
    ("p15", "pdf", "auth", "ar", "stories", {}), ("p16", "pdf", "booking", "ar", "prose", {}),
    ("s17", "scanned", "booking", "en", "numbered", {}), ("s18", "scanned", "leave", "en", "table", {}),
    ("s19", "scanned", "checkout", "en", "stories", {}),
    ("x22", "xlsx", "auth", "en", None, {}), ("x23", "xlsx", "checkout", "ar", None, {}),
    ("x24", "xlsx", "booking", "en", None, {"merged": True}),
    ("c25", "csv", "library", "en", None, {}), ("c26", "csv", "leave", "ar", None, {}),
]

def main():
    manifest = []
    for fid, fmt, domain, lang, variant, extra in PLAN:
        ext = {"scanned": "pdf"}.get(fmt, fmt)
        name = f"{fid}-{domain}-{lang}-{variant or 'sheet'}.{ext}"; path = OUT / name
        entry = {"file": name, "format": fmt, "lang": lang, "domain": domain, "variant": variant, "expected": "parse"}
        if fmt == "docx" and lang == "mixed":
            b_ar, g_ar = blocks_for(domain, "ar", variant); b_en, g_en = blocks_for(domain, "en", "prose")
            for b in b_en: b["lang"] = "en"
            off = len(g_ar)
            for b in b_en:
                if "gold" in b: b["gold"] += off
            write_docx(path, b_ar + b_en[1:], "ar"); gold = g_ar + g_en
        elif fmt == "docx":
            blocks, gold = blocks_for(domain, lang, variant); write_docx(path, blocks, lang)
        elif fmt == "pdf":
            blocks, gold = blocks_for(domain, lang, variant, extra.get("filler", 0))
            entry["pages"] = write_pdf(path, blocks, gold, lang)
        elif fmt == "scanned":
            blocks, gold = blocks_for(domain, lang, variant)
            entry["pages"] = write_scanned(path, blocks, gold); entry["expected"] = "ocr"
        elif fmt == "xlsx": gold = write_xlsx(path, domain, lang, extra.get("merged", False))
        elif fmt == "csv": gold = write_csv(path, domain, lang)
        (GOLD / f"{fid}.json").write_text(json.dumps({"file": name, "requirements": gold}, ensure_ascii=False, indent=1), encoding="utf-8")
        entry["gold"] = f"gold/{fid}.json"; entry["requirements"] = len(gold); entry["acs"] = sum(len(g["ac"]) for g in gold)
        manifest.append(entry); print("wrote", name, entry.get("pages", ""), len(gold), "reqs")

    # malformed / hostile
    src = (OUT / "p10-checkout-en-table.pdf").read_bytes()
    (OUT / "m27-truncated-en.pdf").write_bytes(src[: int(len(src) * 0.6)])
    write_encrypted(OUT / "m28-encrypted-en.pdf")
    write_zip_bomb(OUT / "m29-zipbomb.docx")
    (OUT / "m30-disguised-exe.pdf").write_bytes(b"MZ\x90\x00" + b"\x00" * 60 + b"This program cannot be run in DOS mode.\r\n" + os.urandom(2048))
    manifest += [
        {"file": "m27-truncated-en.pdf", "format": "pdf", "expected": "reject:corrupt"},
        {"file": "m28-encrypted-en.pdf", "format": "pdf", "expected": "reject:encrypted"},
        {"file": "m29-zipbomb.docx", "format": "docx", "expected": "reject:zip_bomb (expanded > 500 MB)"},
        {"file": "m30-disguised-exe.pdf", "format": "pdf", "expected": "reject:magic_bytes"},
        {"file": "s20-*-ar-scanned.pdf", "format": "scanned", "lang": "ar", "expected": "ocr", "status": "pending: generated in parser container (render p13 to images)"},
        {"file": "s21-*-ar-scanned.pdf", "format": "scanned", "lang": "ar", "expected": "ocr", "status": "pending: generated in parser container (render p16 to images)"},
    ]
    (ROOT / "manifest.json").write_text(json.dumps({"generated_by": "corpus/generate.py", "conflicts": CONFLICTS, "files": manifest},
                                                   ensure_ascii=False, indent=1), encoding="utf-8")
    print("manifest entries:", len(manifest))

if __name__ == "__main__":
    main()
