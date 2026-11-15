"""Parser contract tests on the P0 corpus (T-P3-05). Run with:

    python -m unittest discover -s services/parser/tests -t services/parser

Fast by default (sheets, CSV, DOCX, Arabic digital PDF). ``QOS_PARSER_SLOW=1`` adds Docling PDF
layout and OCR (minutes on CPU; needs the OCR models in ``QOS_OCR_MODELS``).
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from qos_parser.main import app
from qos_parser.parse import ParseError, parse

ROOT = Path(__file__).resolve().parents[3]
CORPUS = ROOT / "spikes" / "parser" / "corpus"
SLOW = os.environ.get("QOS_PARSER_SLOW") == "1"


def norm(t: str) -> str:
    t = unicodedata.normalize("NFKC", t)
    t = re.sub(r"[ؐ-ًؚ-ٰٟـ]", "", t)
    t = re.sub(r"[أإآٱ]", "ا", t).replace("ى", "ي").replace("ة", "ه")
    t = re.sub(r"\s+", " ", t).strip().lower()
    # PDF text layers may emit lam-alef as alef-lam: runs of ا/ل are compared sorted (P0 textnorm).
    return re.sub("[ال]{2,}", lambda m: "".join(sorted(m.group(0))), t)


def tokens(t: str) -> list[str]:
    """P0 scoring tokens: script boundaries split, so FR-2 and -2FR give the same bag."""
    return re.findall(r"[a-z]+|d+|[ء-ي]+", norm(t))


def fuzzy_recall(doc: dict, name: str) -> tuple[int, int]:
    """P0 fuzzy measure: a gold string counts when ≥ 90% of its tokens occur in the document."""
    gold = json.loads((CORPUS / "gold" / f"{name[:3]}.json").read_text(encoding="utf-8"))["requirements"]
    have = set(tokens(" ".join(b["text"] for b in doc["blocks"])))
    wanted = [g["text"] for g in gold] + [a for g in gold for a in g["ac"]]
    hit = sum(sum(t in have for t in tokens(w)) >= 0.9 * len(tokens(w)) for w in wanted)
    return hit, len(wanted)


def recall(doc: dict, name: str) -> tuple[int, int]:
    """Gold requirement and AC strings found (normalized substring) in the joined block text."""
    gold = json.loads((CORPUS / "gold" / f"{name[:3]}.json").read_text(encoding="utf-8"))["requirements"]
    text = norm(" \n ".join(b["text"] for b in doc["blocks"]))
    wanted = [g["text"] for g in gold] + [a for g in gold for a in g["ac"]]
    return sum(norm(w) in text for w in wanted), len(wanted)


class ContractTest(unittest.TestCase):
    def check_shape(self, doc: dict, kind: str) -> None:
        self.assertEqual(doc["kind"], kind)
        self.assertTrue(doc["blocks"])
        for i, b in enumerate(doc["blocks"], start=1):
            self.assertEqual(b["id"], f"b{i}")
            self.assertIn(b["type"], {"heading", "paragraph", "list_item", "table_cell"})
            self.assertTrue(b["text"].strip())
            self.assertIsInstance(b["locator"], dict)
            self.assertIn(b["language"], {"ar", "en", "mixed", None})

    def test_spreadsheets_keep_exact_cells(self) -> None:
        for name, kind in [("x22-auth-en-sheet.xlsx", "xlsx"), ("x23-checkout-ar-sheet.xlsx", "xlsx"),
                           ("x24-booking-en-sheet.xlsx", "xlsx"), ("c25-library-en-sheet.csv", "csv"),
                           ("c26-leave-ar-sheet.csv", "csv")]:
            doc = parse(kind, CORPUS / "files" / name)
            self.check_shape(doc, kind)
            found, total = recall(doc, name)
            self.assertEqual(found, total, name)
            self.assertTrue(all({"sheet", "row", "col"} <= b["locator"].keys() for b in doc["blocks"]), name)

    def test_merged_cells_repeat_their_value(self) -> None:
        doc = parse("xlsx", CORPUS / "files" / "x24-booking-en-sheet.xlsx")
        col1 = [b["text"] for b in doc["blocks"] if b["locator"]["col"] == 1 and b["locator"]["row"] > 1]
        self.assertTrue(col1 and all(col1), "every data row has a module value")

    def test_docx_english_and_arabic(self) -> None:
        for name in ["d01-checkout-en-numbered.docx", "d06-auth-ar-table.docx"]:
            doc = parse("docx", CORPUS / "files" / name)
            self.check_shape(doc, "docx")
            found, total = recall(doc, name)
            self.assertEqual(found, total, name)
            self.assertTrue(any(b["type"] == "heading" for b in doc["blocks"]))
            self.assertTrue(all("sectionPath" in b["locator"] for b in doc["blocks"] if b["type"] != "heading" and doc["blocks"][0]["type"] == "heading"))

    def test_arabic_pdf_uses_the_text_layer_in_logical_order(self) -> None:
        doc = parse("pdf", CORPUS / "files" / "p13-library-ar-numbered.pdf")
        self.check_shape(doc, "pdf")
        self.assertEqual(doc["languages"], ["ar"])
        self.assertTrue(all(b["locator"].get("page") == 1 for b in doc["blocks"]))
        found, total = fuzzy_recall(doc, "p13-library-ar-numbered.pdf")
        self.assertGreaterEqual(found / total, 0.8)  # P0 fuzzy on PDF AR: 20/21 requirements
        self.assertIn("الإلكترونية", " ".join(b["text"] for b in doc["blocks"]))  # ligature repaired

    def test_malformed_files_fail_with_a_reason(self) -> None:
        with self.assertRaises(ParseError) as e:
            parse("pdf", CORPUS / "files" / "m27-truncated-en.pdf")
        self.assertIn(e.exception.code, {"pdf_unreadable", "parse_failed"})
        with self.assertRaises(ParseError):
            parse("odt", CORPUS / "files" / "d01-checkout-en-numbered.docx")

    @unittest.skipUnless(SLOW, "set QOS_PARSER_SLOW=1 for Docling PDF layout and OCR")
    def test_english_pdf_and_scans(self) -> None:
        doc = parse("pdf", CORPUS / "files" / "p10-checkout-en-table.pdf")
        found, total = recall(doc, "p10-checkout-en-table.pdf")
        self.assertEqual(found, total)
        scan = parse("pdf", CORPUS / "files" / "s20-library-ar-scanned.pdf")
        self.assertEqual(scan["ocrPages"], 1)
        self.assertTrue(all(0 <= b["ocrConfidence"] <= 1 for b in scan["blocks"]))


class HttpTest(unittest.TestCase):
    def test_parse_over_http_and_errors(self) -> None:
        client = TestClient(app)
        self.assertEqual(client.get("/healthz").json()["status"], "ok")
        with (CORPUS / "files" / "c25-library-en-sheet.csv").open("rb") as f:
            res = client.post("/v1/parse", data={"kind": "csv"}, files={"file": ("x.csv", f, "text/csv")})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["kind"], "csv")
        bad = client.post("/v1/parse", data={"kind": "exe"}, files={"file": ("x.exe", b"MZ", "application/octet-stream")})
        self.assertEqual(bad.status_code, 422)
        with (CORPUS / "files" / "m27-truncated-en.pdf").open("rb") as f:
            broken = client.post("/v1/parse", data={"kind": "pdf"}, files={"file": ("x.pdf", f, "application/pdf")})
        self.assertEqual(broken.status_code, 422)

    def test_render_a_pdf_page_as_png(self) -> None:
        client = TestClient(app)
        pdf = (CORPUS / "files" / "p09-library-en-numbered.pdf").read_bytes()
        res = client.post("/v1/render", data={"page": "1", "scale": "1"}, files={"file": ("x.pdf", pdf, "application/pdf")})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["content-type"], "image/png")
        self.assertTrue(res.content.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertGreaterEqual(int(res.headers["x-page-count"]), 1)
        # A4/Letter at 72 dpi: roughly 600 x 800 pixels.
        width = int.from_bytes(res.content[16:20], "big")
        self.assertTrue(500 <= width <= 700, width)
        far = client.post("/v1/render", data={"page": "999"}, files={"file": ("x.pdf", pdf, "application/pdf")})
        self.assertEqual((far.status_code, far.json()["detail"]["code"]), (422, "page_out_of_range"))
        scale = client.post("/v1/render", data={"page": "1", "scale": "9"}, files={"file": ("x.pdf", pdf, "application/pdf")})
        self.assertEqual(scale.status_code, 422)
        not_pdf = client.post("/v1/render", data={"page": "1"}, files={"file": ("x.pdf", b"MZ\x90\x00", "application/pdf")})
        self.assertEqual((not_pdf.status_code, not_pdf.json()["detail"]["code"]), (422, "unsupported_type"))


if __name__ == "__main__":
    unittest.main()
