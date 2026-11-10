"""Prototype of the upload pre-validation in doc 21 §8 / M04-AC-08, run before any parser sees a file."""
import zipfile
from pathlib import Path

MAGIC = {".pdf": [b"%PDF-"], ".docx": [b"PK\x03\x04"], ".xlsx": [b"PK\x03\x04"], ".csv": None}
MAX_BYTES = 50 * 2**20
ZIP_MAX_ENTRIES, ZIP_MAX_EXPANDED = 10_000, 500 * 2**20


def validate(path: Path) -> tuple[bool, str]:
    ext = path.suffix.lower()
    if ext not in MAGIC:
        return False, "unsupported_extension"
    size = path.stat().st_size
    if size > MAX_BYTES:
        return False, "too_large"
    head = path.open("rb").read(8)
    if MAGIC[ext] and not any(head.startswith(m) for m in MAGIC[ext]):
        return False, "magic_bytes_mismatch"
    if ext in (".docx", ".xlsx"):
        try:
            with zipfile.ZipFile(path) as z:
                infos = z.infolist()
                if len(infos) > ZIP_MAX_ENTRIES:
                    return False, "zip_too_many_entries"
                if sum(i.file_size for i in infos) > ZIP_MAX_EXPANDED:  # declared sizes; parser also streams with a cap
                    return False, "zip_bomb_suspected"
                if ext == ".docx" and "word/document.xml" not in z.namelist():
                    return False, "not_a_docx"
        except zipfile.BadZipFile:
            return False, "corrupt_zip"
    if ext == ".pdf":
        data = path.read_bytes()
        if b"/Encrypt" in data[-4096:] or b"/Encrypt" in data:
            return False, "encrypted_pdf"
        if b"%%EOF" not in data[-2048:]:
            return False, "corrupt_or_truncated_pdf"
    if ext == ".csv":
        try:
            path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            return False, "csv_not_utf8"
    return True, "ok"
