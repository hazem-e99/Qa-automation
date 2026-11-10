# Phase 0 — Spikes

> Throwaway code that answers the Phase 0 questions ([docs/planning/36 §9](../docs/planning/36-technical-validation.md), [25 P0](../docs/planning/25-implementation-roadmap.md)). Nothing in `spikes/` is merged into the product. Results are written back into `docs/planning/36-technical-validation.md`.
>
> Owner approval to start implementation: **2026-11-09** (chat approval: "Approve, start P0").
>
> **P0 gate closed 2026-11-10.** Record: [docs/status/gates/P0.md](../docs/status/gates/P0.md).

## Status
| Spike | Question | Status | Result |
|---|---|---|---|
| T-P0-05 | Version pinning & licences | **Done (registry part)**. Image builds are checked inside T-P0-04 | [versions/RESULTS.md](versions/RESULTS.md) |
| T-P0-02 | pg-boss 12 + Drizzle transactional send | **Done: 5/5 PASS** on embedded PG 18.6 and on the pg17 Docker image | [queue/RESULTS.md](queue/RESULTS.md) |
| T-P0-03 | n8n CE behaviour (CLI import/export, activation, health, API, HMAC) | **Done** natively and on Docker with Postgres. Finding: `$env` is blocked in Code nodes by default | [n8n/RESULTS.md](n8n/RESULTS.md) |
| T-P0-04 | Playwright sandbox stability on this machine | **Done: 50/50 runs pass**, 0 OOM. Security finding on the socket proxy (see results) | [sandbox/RESULTS.md](sandbox/RESULTS.md) |
| T-P0-01 | Parser bake-off on AR/EN corpus | **Host run done** (Docling, pdfplumber, PDFium, EasyOCR; 26 files plus 4 hostile). Docling is the primary parser; Arabic PDF text comes from PDFium; Arabic scans use EasyOCR with RTL line ordering. **Optional in Docker:** Tika/poppler/Tesseract comparison, warm-service speed | [parser/bakeoff/RESULTS.md](parser/bakeoff/RESULTS.md) |
| T-P0-06 | AI structured output (run on Gemini, ADR-0019) | **Done:** 24/24 schema-valid on two models; quote grounding 45/45 on `gemini-3.5-flash`. Cost and embeddings not measured | [ai/RESULTS.md](ai/RESULTS.md) |

## Environment found (2026-11-09)
| Item | Found | Needed |
|---|---|---|
| OS | Windows 11 Pro, 12 logical CPUs, 15.7 GB RAM | OK (AS-02: 16 GB tier, run parallelism 2) |
| Disk | C: about 16 GB free (was 4 GB on 2026-11-09), D: 62 GB free | Docker/WSL data must live on **D:**. Free ≥ 15 GB on C: for the Docker Desktop install and WSL |
| Node | 24.18.0 | OK (Node 24 LTS) |
| pnpm | 9.15.9 | Pin 12.18.0 via `packageManager` (P1) |
| git | 2.55.0 | OK |
| Python | 3.14.7 (`py`) | Parser runs in a Python 3.12 container instead |
| Docker | Docker Desktop 4.99, Engine 29.9.3, WSL2, data on D: (installed 2026-11-10) | OK |
