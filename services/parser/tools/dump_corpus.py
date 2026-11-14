"""Writes the parser output for every valid P0 corpus file to JSON fixtures, so the extraction
rules (TypeScript) are tested and measured in CI without Python. Re-run after parser changes:

    python services/parser/tools/dump_corpus.py packages/modules/requirements/test/fixtures/parsed
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from qos_parser.parse import parse  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
CORPUS = ROOT / "spikes" / "parser" / "corpus" / "files"
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
for f in sorted(CORPUS.iterdir()):
    if f.name.startswith("m"):
        continue  # hostile files never reach the parser
    t = time.time()
    doc = parse(f.suffix[1:], f)
    (out / f"{f.stem}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{f.name}: {len(doc['blocks'])} blocks, {time.time() - t:.1f}s", flush=True)
