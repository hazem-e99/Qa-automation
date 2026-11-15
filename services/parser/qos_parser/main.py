"""HTTP sidecar (ADR-0013): ``POST /v1/parse`` and health. No network egress is needed: OCR models
are loaded from the image; downloads are off unless QOS_OCR_DOWNLOAD=1 (development only).
The service holds no state and keeps no files: each upload is written to a private temp file and
removed when parsing ends."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool

from .parse import PARSER_VERSION, ParseError, parse, render_pdf_page

MAX_BYTES = int(os.environ.get("QOS_PARSER_MAX_BYTES", str(50 * 2**20)))
app = FastAPI(title="QualityOS parser", version=PARSER_VERSION, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
@app.get("/readyz")
def health() -> dict:
    return {"service": "parser", "status": "ok", "version": PARSER_VERSION, "checks": {}}


@app.post("/v1/parse")
async def parse_endpoint(kind: str = Form(...), file: UploadFile = File(...)) -> dict:
    if kind not in ("pdf", "docx", "xlsx", "csv"):
        raise HTTPException(status_code=422, detail={"code": "unsupported_type"})
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail={"code": "too_large"})
    fd, name = tempfile.mkstemp(suffix=f".{kind}")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        return await run_in_threadpool(parse, kind, Path(name))
    except ParseError as e:
        raise HTTPException(status_code=422, detail={"code": e.code, "detail": e.detail}) from e
    finally:
        Path(name).unlink(missing_ok=True)


@app.post("/v1/render")
async def render_endpoint(
    file: UploadFile = File(...), page: int = Form(...), scale: float = Form(1.5)
) -> Response:
    """One PDF page as PNG for the source viewer. The page count comes back in X-Page-Count."""
    if not 0.5 <= scale <= 2:
        raise HTTPException(status_code=422, detail={"code": "scale_out_of_range"})
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail={"code": "too_large"})
    if not data.startswith(b"%PDF-"):
        raise HTTPException(status_code=422, detail={"code": "unsupported_type"})
    fd, name = tempfile.mkstemp(suffix=".pdf")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        png, pages = await run_in_threadpool(render_pdf_page, Path(name), page, scale)
    except ParseError as e:
        raise HTTPException(status_code=422, detail={"code": e.code, "detail": e.detail}) from e
    finally:
        Path(name).unlink(missing_ok=True)
    return Response(content=png, media_type="image/png", headers={"X-Page-Count": str(pages)})
