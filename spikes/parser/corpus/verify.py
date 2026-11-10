"""Sanity-check the generated corpus: gold text present in DOCX/XLSX/CSV, malformed files hostile as intended."""
import csv, json, zipfile
from pathlib import Path
from docx import Document
from openpyxl import load_workbook
ROOT = Path(__file__).parent
m = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
problems = 0
for e in m["files"]:
    f = ROOT / "files" / e["file"]
    if "gold" not in e: continue
    gold = json.loads((ROOT / e["gold"]).read_text(encoding="utf-8"))["requirements"]
    if e["format"] == "docx":
        d = Document(f); text = "\n".join(p.text for p in d.paragraphs) + "\n" + "\n".join(c.text for t in d.tables for r in t.rows for c in r.cells)
    elif e["format"] == "xlsx":
        ws = load_workbook(f).active; text = "\n".join(str(c.value) for r in ws.iter_rows() for c in r if c.value)
    elif e["format"] == "csv":
        text = f.read_text(encoding="utf-8-sig")
    else:
        continue  # PDFs checked visually / by parsers in T-P0-01
    for g in gold:
        for s in [g["text"]] + g["ac"]:
            if s not in text: problems += 1; print("MISSING", e["file"], s[:60])
    print("ok" if problems == 0 else "..", e["file"], len(gold), "reqs")
z = zipfile.ZipFile(ROOT / "files/m29-zipbomb.docx")
print("zip bomb: compressed KB", (ROOT / "files/m29-zipbomb.docx").stat().st_size // 1024, "expanded MB", sum(i.file_size for i in z.infolist()) // 2**20)
print("encrypted has /Encrypt:", b"/Encrypt" in (ROOT / "files/m28-encrypted-en.pdf").read_bytes())
print("truncated has %%EOF:", b"%%EOF" in (ROOT / "files/m27-truncated-en.pdf").read_bytes())
print("disguised magic:", (ROOT / "files/m30-disguised-exe.pdf").read_bytes()[:2])
p12 = json.loads((ROOT / "gold/p12.json").read_text(encoding="utf-8"))["requirements"]
print("p12 pages of reqs:", [g.get("page") for g in p12])
print("TOTAL PROBLEMS", problems)
