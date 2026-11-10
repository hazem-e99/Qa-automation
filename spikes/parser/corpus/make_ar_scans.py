"""Create Arabic 'scanned' PDFs s20/s21 by rendering p13/p16 to images (pypdfium2) and adding scan noise."""
import io, json, random, shutil
from pathlib import Path
import pypdfium2 as pdfium
from fpdf import FPDF
from PIL import ImageFilter
ROOT = Path(__file__).parent; random.seed(11)
for sid, src in [("s20", "p13-library-ar-numbered"), ("s21", "p16-booking-ar-prose")]:
    doc = pdfium.PdfDocument(str(ROOT / "files" / f"{src}.pdf")); out = FPDF(format="A4")
    for page in doc:
        img = page.render(scale=150 / 72).to_pil().convert("L")
        img = img.rotate(random.uniform(-0.8, 0.8), fillcolor=255).filter(ImageFilter.GaussianBlur(0.6))
        px = img.load(); W, H = img.size
        for _ in range(4000): px[random.randrange(W), random.randrange(H)] = random.randrange(80, 200)
        buf = io.BytesIO(); img.save(buf, "PNG"); buf.seek(0); out.add_page(); out.image(buf, x=0, y=0, w=210, h=297)
    name = f"{sid}-{src.split('-')[1]}-ar-scanned.pdf"; out.output(str(ROOT / "files" / name))
    gold = json.loads((ROOT / "gold" / f"{src[:3]}.json").read_text(encoding="utf-8")); gold["file"] = name
    (ROOT / "gold" / f"{sid}.json").write_text(json.dumps(gold, ensure_ascii=False, indent=1), encoding="utf-8")
    m = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    m["files"] = [e for e in m["files"] if not e["file"].startswith(sid)] + [
        {"file": name, "format": "scanned", "lang": "ar", "domain": src.split("-")[1], "variant": src.split("-")[3],
         "expected": "ocr", "gold": f"gold/{sid}.json", "requirements": len(gold["requirements"]),
         "acs": sum(len(g["ac"]) for g in gold["requirements"]), "pages": len(doc)}]
    (ROOT / "manifest.json").write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote", name)
