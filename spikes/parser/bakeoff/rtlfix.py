"""Post-processor candidate for the DocumentParser adapter: undo visual (reversed) word order in RTL table cells.

Creates out/docling+rtlfix/*.json from out/docling/*.json so the same scorer can compare before/after.
"""
import json, re
from pathlib import Path

AR = re.compile(r"[؀-ۿ]")
OUT = Path(__file__).parent / "out"


def is_rtl(text):
    letters = [c for c in text if c.isalpha()]
    return bool(letters) and sum(bool(AR.match(c)) for c in letters) / len(letters) > 0.5


def fix_block(b):
    if b.get("kind") == "cell" and is_rtl(b["text"]):
        b = dict(b, text=" ".join(reversed(b["text"].split())))
    return b


if __name__ == "__main__":
    dst = OUT / "docling+rtlfix"; dst.mkdir(exist_ok=True)
    for f in (OUT / "docling").glob("*.json"):
        r = json.loads(f.read_text(encoding="utf-8"))
        if r.get("ok"): r["blocks"] = [fix_block(b) for b in r["blocks"]]
        (dst / f.name).write_text(json.dumps(r, ensure_ascii=False), encoding="utf-8")
    print("written", len(list(dst.glob("*.json"))))
