"""T-P0-01 bake-off driver: validate uploads, run each parser per file (subprocess + timeout), score vs gold.

Usage (from spikes/parser): .venv/Scripts/python.exe bakeoff/bakeoff.py docling pdfplumber
Writes bakeoff/out/<parser>/<file>.json and bakeoff/out/report.md
Scoring measures *parser fidelity* (does the gold text survive extraction, on the right page, in the right
table row?), not requirement-extraction rules — those are P3 (T-P3-06) and are scored separately later.
"""
import json, os, subprocess, sys, time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from textnorm import tokens
from validate_upload import validate

HERE = Path(__file__).parent
CORPUS = HERE.parent / "corpus"
OUT = HERE / "out"
PY = sys.executable
TIMEOUT = 600
PDF_ONLY = {"pdfplumber", "pdfium", "docling_pdfium"}
ENV = dict(os.environ, HF_HOME=r"D:\dev\.cache\hf", EASYOCR_MODULE_PATH=r"D:\dev\.cache\easyocr",
           TMP=r"D:\dev\.tmp", TEMP=r"D:\dev\.tmp", PYTHONIOENCODING="utf-8")


def find(gold_toks, doc_toks):
    """Return (exact, bag_recall, start_index) of gold token sequence within doc tokens."""
    n = len(gold_toks)
    if n == 0: return True, 1.0, 0
    s = " " + " ".join(doc_toks) + " "; g = " " + " ".join(gold_toks) + " "
    if g in s:
        return True, 1.0, s[: s.index(g)].count(" ")
    rev = {t[::-1] for t in gold_toks}  # visual-order extraction may reverse Arabic words
    best, best_i, w = 0.0, None, int(n * 1.6) + 2
    for i in range(0, max(1, len(doc_toks) - n + 1)):
        win = doc_toks[i:i + w]; ws = set(win)
        hit = sum(1 for t in gold_toks if t in ws or t[::-1] in ws or (t in rev and t[::-1] in ws))
        r = hit / n
        if r > best: best, best_i = r, i
    return False, best, best_i


def score_file(entry, result):
    gold = json.loads((CORPUS / entry["gold"]).read_text(encoding="utf-8"))["requirements"]
    blocks = result.get("blocks", [])
    doc_toks, owner = [], []  # token -> block index
    for bi, b in enumerate(blocks):
        t = tokens(b["text"]); doc_toks += t; owner += [bi] * len(t)
    m = defaultdict(int)
    for g in gold:
        for kind, s in [("req", g["text"])] + [("ac", a) for a in g["ac"]]:
            gt = tokens(s); exact, bag, idx = find(gt, doc_toks)
            m[f"{kind}_total"] += 1
            m[f"{kind}_exact"] += exact
            m[f"{kind}_fuzzy"] += bag >= 0.9
            if kind == "req" and g.get("page") and idx is not None and bag >= 0.9 and owner:
                m["loc_total"] += 1
                m["loc_ok"] += blocks[owner[min(idx, len(owner) - 1)]].get("page") == g["page"]
        if entry.get("variant") == "table" and g.get("id"):  # ID and requirement in the same table row?
            m["row_total"] += 1
            rows = defaultdict(list)
            for b in blocks:
                if b.get("kind") == "cell": rows[(b.get("table"), b.get("row"))].append(b["text"])
            idt, rt = set(tokens(g["id"])), tokens(g["text"])
            m["row_ok"] += any(idt <= set(tokens(" ".join(c))) and
                               sum(t in set(tokens(" ".join(c))) for t in rt) / max(1, len(rt)) >= 0.9
                               for c in rows.values())
    return m


def main(parsers):
    manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))["files"]
    entries = [e for e in manifest if not e.get("status", "").startswith("pending")]
    report = {"validation": {}, "runs": defaultdict(dict)}
    for e in entries:
        report["validation"][e["file"]] = validate(CORPUS / "files" / e["file"])
    for p in parsers:
        (OUT / p).mkdir(parents=True, exist_ok=True)
        for e in entries:
            f = CORPUS / "files" / e["file"]
            ok, reason = report["validation"][e["file"]]
            if not ok:  # product design: rejected files never reach a parser
                report["runs"][p][e["file"]] = {"skipped": f"rejected by pre-validation: {reason}"}; continue
            if p in PDF_ONLY and f.suffix.lower() != ".pdf":
                continue
            langs = "en,ar" if e.get("lang") in ("ar", "mixed") else "en"
            out = OUT / p / (e["file"] + ".json"); t0 = time.time()
            try:
                if not (os.environ.get('SCORE_ONLY') and out.exists()):
                    subprocess.run([PY, str(HERE / "run_parser.py"), p, str(f), str(out), langs], env=ENV, timeout=TIMEOUT,
                               capture_output=True)
                res = json.loads(out.read_text(encoding="utf-8"))
            except subprocess.TimeoutExpired:
                res = {"ok": False, "error": f"timeout>{TIMEOUT}s", "seconds": TIMEOUT}
            except Exception as ex:
                res = {"ok": False, "error": f"driver: {ex}", "seconds": round(time.time() - t0, 1)}
            row = {"ok": res.get("ok"), "error": res.get("error"), "seconds": res.get("seconds"), "pages": res.get("pages")}
            if res.get("ok") and "gold" in e:
                row.update(score_file(e, res))
            report["runs"][p][e["file"]] = row
            print(p, e["file"], {k: row[k] for k in ("ok", "seconds") if k in row}, row.get("error") or "")
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    write_md(report, entries)


def group(e):
    if e["file"].startswith("m"): return "hostile"
    return f'{e["format"]}-{"ar" if e.get("lang") in ("ar", "mixed") else "en"}'


def write_md(report, entries):
    lines = ["# T-P0-01 bake-off report (host run, no Docker)", "",
             "## Upload pre-validation (prototype of 21 §8)", "| File | Accepted | Reason |", "|---|---|---|"]
    for f, (ok, r) in report["validation"].items():
        if f.startswith("m") or not ok: lines.append(f"| {f} | {ok} | {r} |")
    lines += ["", "## Parser fidelity by group",
              "| Parser | Group | Files ok | Req exact | Req fuzzy≥0.9 | AC exact | AC fuzzy≥0.9 | Page locator | Table rows intact | Avg s/file |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    by = {e["file"]: e for e in entries}
    for p, runs in report["runs"].items():
        agg = defaultdict(lambda: defaultdict(float))
        for f, r in runs.items():
            if "skipped" in r: continue
            a = agg[group(by[f])]; a["n"] += 1; a["ok"] += bool(r.get("ok")); a["sec"] += r.get("seconds") or 0
            for k, v in r.items():
                if isinstance(v, (int, float)) and k not in ("seconds", "pages") and not isinstance(v, bool): a[k] += v
        pct = lambda a, k: f'{a[k + "_exact" if k in ("req","ac") else k]:.0f}/{a[k + "_total"]:.0f}' if a[k + "_total"] else "–"
        for gname, a in sorted(agg.items()):
            fz = lambda k: f'{a[k + "_fuzzy"]:.0f}/{a[k + "_total"]:.0f}' if a[k + "_total"] else "–"
            loc = f'{a["loc_ok"]:.0f}/{a["loc_total"]:.0f}' if a["loc_total"] else "–"
            rows = f'{a["row_ok"]:.0f}/{a["row_total"]:.0f}' if a["row_total"] else "–"
            lines.append(f'| {p} | {gname} | {a["ok"]:.0f}/{a["n"]:.0f} | {pct(a,"req")} | {fz("req")} | {pct(a,"ac")} | {fz("ac")} | {loc} | {rows} | {a["sec"]/max(1,a["n"]):.1f} |')
    lines += ["", "## Per-file errors"]
    for p, runs in report["runs"].items():
        for f, r in runs.items():
            if r.get("error"): lines.append(f"- {p} / {f}: {r['error']}")
    (OUT / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main(sys.argv[1:] or ["docling", "pdfplumber"])
