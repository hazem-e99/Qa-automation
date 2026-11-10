# ADR-0013 — Python document-parser sidecar
- Status: Accepted (library choice pending OD-02 / spike T-P0-01) · Date: 2026-11-09

## Context
We need to extract text, structure, and tables from DOCX, PDF, and XLSX files, including scanned documents and Arabic text. Python has far better tooling for this than Node (Docling, unstructured, pdfplumber, Tesseract). Parsing files that come from outside is also a security risk, so the parser must be isolated.

## Decision
Run a separate `parser` service, written in Python with FastAPI, behind the `DocumentParser` port.

- **Stateless.** The service fetches the file from a short-lived internal URL and returns a `ParsedDocument` JSON. Each block in it carries locators (page, section, table cell), its language, and the OCR confidence.
- **Locked down.** It runs as a non-root user with a read-only filesystem and **no outbound network**, under memory and time limits.
- **One file per request.** If parsing exceeds the time limit, the worker process is killed.
- **Library choice.** Spike T-P0-01 picks the parsing library.

## Consequences
- (+) Best-available extraction quality, and a parser exploit is contained to a small, isolated service.
- (−) The platform gains a second language runtime. To limit the cost, the service stays small and its interface is covered by contract tests.
