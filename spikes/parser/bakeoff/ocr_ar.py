"""Arabic OCR check: render scanned pages with pypdfium2, OCR with EasyOCR (ar+en), score vs gold."""
import json, sys, time
from pathlib import Path
import numpy as np, pypdfium2 as pdfium, easyocr
sys.path.insert(0, str(Path(__file__).parent))
from textnorm import tokens
from bakeoff import find
C = Path(__file__).parent.parent / "corpus"
reader = easyocr.Reader(["ar", "en"], gpu=False, model_storage_directory=r"D:\dev\.cache\easyocr")
for f in sorted((C / "files").glob("s2*-ar-scanned.pdf")):
    t0 = time.time(); doc_toks = []; confs = []
    for page in pdfium.PdfDocument(str(f)):
        img = np.array(page.render(scale=2).to_pil().convert("RGB"))
        res = reader.readtext(img, paragraph=False)
        # RTL reading order: group boxes into lines by y, then read each line right-to-left
        res.sort(key=lambda r: (min(p[1] for p in r[0])))
        lines = []
        for r in res:
            y0 = min(p[1] for p in r[0]); h = max(p[1] for p in r[0]) - y0
            if lines and abs(lines[-1][0] - y0) < 0.6 * h: lines[-1][1].append(r)
            else: lines.append([y0, [r]])
        for _, ln in lines:
            for _, text, conf in sorted(ln, key=lambda r: -max(p[0] for p in r[0])): doc_toks += tokens(text); confs.append(conf)
    gold = json.loads((C / "gold" / (f.name[:3] + ".json")).read_text(encoding="utf-8"))["requirements"]
    tok_hit = tok_all = 0; req = ac = 0; nreq = len(gold); nac = sum(len(g["ac"]) for g in gold); ds = set(doc_toks)
    for g in gold:
        req += find(tokens(g["text"]), doc_toks)[1] >= 0.9
        for a in g["ac"]: ac += find(tokens(a), doc_toks)[1] >= 0.9
        for s in [g["text"]] + g["ac"]:
            t = tokens(s); tok_all += len(t); tok_hit += sum(x in ds for x in t)
    print(f"{f.name}: req fuzzy {req}/{nreq}, ac fuzzy {ac}/{nac}, word recall {tok_hit}/{tok_all}, mean conf {sum(confs)/len(confs):.2f}, {time.time()-t0:.0f}s")
