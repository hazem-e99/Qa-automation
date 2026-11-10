# 36 — Technical Validation and References

> Status: **Planned** · Owner: Principal Architect · Facts checked: 2026-11-08 / 2026-11-09

This document separates **confirmed facts** from **third-party claims** and **unverified assumptions**. Any design decision that rests on an item marked *Unverified* has a matching Phase 0 spike in [26](26-task-breakdown.md) (task IDs `T-P0-*`).

**Status legend**
- **Confirmed**: read in the vendor's official documentation, license text, or source repository on the date shown.
- **Third-party**: reported consistently by reputable secondary sources, but not read in official docs.
- **Unverified**: an assumption. It must be proven before the design depends on it.

---

## 1. n8n

| # | Claim | Status | Source | Design consequence |
|---|---|---|---|---|
| N1 | n8n is licensed under the **Sustainable Use License (SUL)**. It may be used or modified "only for your own internal business purposes or for non-commercial or personal use". It may be distributed only free of charge and for non-commercial purposes. | Confirmed | `github.com/n8n-io/n8n/blob/master/LICENSE.md` | Personal pilot use is clearly allowed. Running it inside a company *for that company's own internal workflows* fits the wording, but the license **does not define "internal business purposes"**. **Legal must confirm before company rollout** (Open Decision OD-01 in [31](31-assumptions-and-open-decisions.md)). |
| N2 | Files with `.ee.` in the name or path need a separate n8n Enterprise license. | Confirmed | LICENSE.md | QualityOS uses no enterprise-only n8n features. |
| N3 | Community Edition excludes: custom variables, environments, external secrets, external binary-data storage, log streaming, multi-main mode, projects, SSO (SAML/LDAP), sharing of workflows and credentials, and **version control using Git**. Queue mode *is* included. | Confirmed | `docs.n8n.io/hosting/community-edition-features` | Workflows are versioned with the CLI export/import (N4). n8n stores only one credential: the QualityOS service token. Team-level n8n access is not offered. QA engineers configure automation in QualityOS ([M11](modules/M11-automation-center.md)). |
| N4 | `n8n export:workflow --backup --output=<dir>` exports every workflow as separate, pretty-printed JSON files. `n8n import:workflow --separate --input=<dir>` imports them. Importing a workflow whose ID already exists **overwrites** it. Credentials must be exported to a separate directory. | Confirmed (overwrite behavior: Third-party) | `docs.n8n.io/deploy/host-n8n/keep-n8n-running/backup-and-restore` | `infra/n8n/workflows/*.json` is the source of truth. Import is part of deployment, and stable IDs make re-import idempotent. Credentials are never committed. |
| N5 | The n8n public REST API (`/api/v1`, header `X-N8N-API-KEY`) is available on self-hosted Community Edition. | **Unverified** (only third-party sources say so) | — | The design does not depend on it. Health is checked through `/healthz`. Spike `T-P0-03` confirms whether the API can be used to read execution status. |
| N6 | n8n has `/healthz` (and optionally `/healthz/readiness`) endpoints. | Unverified for the current version | — | Spike `T-P0-03`. Fallback: an HTTP probe of a dedicated `GET` webhook workflow `qos-health`. |

## 2. Azure DevOps (Boards, Repos, Pipelines)

| # | Claim | Status | Source | Design consequence |
|---|---|---|---|---|
| A1 | **Azure DevOps OAuth** (the legacy app registration model) is deprecated and scheduled for removal in 2026. New registrations have been blocked since April 2025. **Microsoft Entra ID OAuth** is the recommended replacement. | Confirmed | `learn.microsoft.com/azure/devops/integrate/get-started/authentication/azure-devops-oauth` | The Azure DevOps adapter will never support legacy Azure DevOps OAuth. It supports two auth strategies: `pat` for the pilot and `entra` for enterprise (app registration or service principal, client credentials, certificate preferred). |
| A2 | Entra access tokens for Azure DevOps are short-lived (about 1 hour). | Confirmed | `learn.microsoft.com/azure/devops/integrate/get-started/authentication/entra` | The adapter caches tokens with refresh before they expire. Tokens are never persisted. Only the client secret or certificate reference is stored. |
| A3 | PAT maximum lifetime is 1 year. Tenant admins can restrict PAT scope and lifespan, and can block global PATs and full-scoped PATs. | Confirmed | `learn.microsoft.com/azure/devops/organizations/accounts/manage-pats-with-policies-for-administrators` | Each connection stores the PAT expiry date. A class-E job `credentials.expiry-check` warns 14 days and 3 days before expiry. Required scopes are documented in [13](13-integration-design.md) (minimum: Work Items Read for requirements, plus Read & Write for issue sync). |
| A4 | Global PATs (organization-agnostic) are being retired. A third-party source gives 2026-12-01 as the date they stop working. | Third-party (retirement announcement Confirmed, date Third-party) | devblogs.microsoft.com, docs.mend.io | The connection wizard accepts **organization-scoped** PATs only and validates against the specific organization URL. |
| A5 | Service hook "Web Hooks" deliveries are **not signed**. Supported authentication is HTTP Basic (Microsoft requires HTTPS for it) or static custom headers, and header values are visible to anyone who can view the subscription. | Confirmed | `learn.microsoft.com/azure/devops/service-hooks/services/webhooks` | Inbound Azure DevOps webhooks are authenticated with a per-connection Basic credential, used only over HTTPS. The payload is treated as a **hint**: the adapter re-fetches the work item by ID and revision through the REST API before acting. See [13 §5](13-integration-design.md). |
| A6 | Work item revisions are retrievable through the REST API (work item `rev` and the revisions endpoint). | Confirmed (well-documented API) | Azure DevOps REST API reference | `SourceSnapshot.externalVersion = rev`. Polling uses a WIQL query with `System.ChangedDate` as the cursor. |
| A7 | Native Microsoft Account (MSA) support for Entra OAuth on the Azure DevOps resource is incomplete. | Third-party | Microsoft Q&A, SmartGit blog | For the pilot, if a personal Azure DevOps organization is backed by MSA, use the `pat` strategy. Logged as risk R-14 in [30](30-risks-and-mitigations.md). |

## 3. GitHub / GitLab webhooks and auth

| # | Claim | Status | Source | Design consequence |
|---|---|---|---|---|
| G1 | GitHub signs webhook payloads with HMAC-SHA256 in `X-Hub-Signature-256`. It sends a delivery GUID in `X-GitHub-Delivery`. | Confirmed (long-standing documented behavior) | docs.github.com webhooks | Signature verification uses a constant-time compare. The inbox dedupe key is `X-GitHub-Delivery`. |
| G2 | GitLab sends a shared secret in `X-Gitlab-Token` (not an HMAC signature). It sends `X-Gitlab-Event` and, in recent versions, an idempotency/UUID header. | Confirmed for the token. The UUID header name must be checked per version: **Unverified** | docs.gitlab.com webhooks | The secret is verified with a constant-time compare. The dedupe key falls back to a payload hash when no delivery ID header is present. Spike `T-P13-02`. |
| G3 | GitHub fine-grained PATs and GitHub Apps support per-repository, least-privilege permissions. | Confirmed | docs.github.com | Pilot: a fine-grained PAT scoped to the selected repositories. Enterprise: a GitHub App is recommended (short-lived installation tokens). |

## 4. pg-boss (job queue)

| # | Claim | Status | Source | Design consequence |
|---|---|---|---|---|
| Q1 | The current major version is **12** (12.38.1 when checked). It requires Node ≥ 22.12 (or Bun) and PostgreSQL ≥ 13. | Confirmed | `pgboss.io` | Node 24 LTS or 26 LTS, and Postgres 17. |
| Q2 | Uses `SELECT … FOR UPDATE SKIP LOCKED` so concurrent workers can claim jobs. | Confirmed | `github.com/timgit/pg-boss` | Multiple worker processes can scale horizontally. |
| Q3 | Jobs can be **sent inside an existing transaction** through a `db` adapter exposing `executeSql`. Adapters exist for Drizzle, Knex, Kysely, and Prisma. | Confirmed | `pgboss.io` | **Transactional enqueue**: a domain state change and its job commit atomically. This complements the outbox ([ADR-0007](adr/ADR-0007-outbox-inbox.md)). |
| Q4 | Queue policies: `standard`, `short` (≤1 queued), `singleton` (≤1 active), `stately` (≤1 per state), `exclusive` (≤1 queued or active), `key_strict_fifo` (FIFO per `singletonKey`). All can be scoped by `singletonKey`. | Confirmed | `pgboss.io/api/queues` | `sync.poll` uses `stately` keyed by connection. `requirements.reanalyze` uses `key_strict_fifo` keyed by requirement. Run execution uses `standard` with controller-side concurrency control. See [17 §3](17-test-execution-engine.md). |
| Q5 | Retry options: `retryLimit` (default 2), `retryDelay`, `retryBackoff`, `retryDelayMax`. Also `expireInSeconds` (default 15 min, max 86 400). An expired active job "is retried or failed". `heartbeatSeconds` (≥10): a missed heartbeat fails or retries the job. `deadLetter` queues receive jobs whose retries are exhausted. | Confirmed | `pgboss.io/api/jobs`, `/api/queues` | **Delivery is at-least-once.** A handler may run more than once (crash after side effect, expiry, missed heartbeat). Every consumer is idempotent ([22 §4](22-observability-and-reliability.md)). |
| Q6 | `cancel(name, id)`, `resume(name, id)`, and `retry(name, id)` are available. | Confirmed | `pgboss.io/api/jobs` | Run cancellation uses `cancel` plus a domain-level `cancel_requested` flag, because cancelling a job does not stop an already-started container ([17 §7](17-test-execution-engine.md)). |
| Q7 | Cron and RRULE scheduling are built in. | Confirmed | `pgboss.io` | Used **only** for class-E maintenance schedules and the fallback scheduler tick. User-facing schedules are automation rules ([18](18-n8n-orchestration.md)). |

## 5. Playwright

| # | Claim | Status | Source | Design consequence |
|---|---|---|---|---|
| P1 | The official Docker image runs as `root` by default, which **disables the Chromium sandbox**. For untrusted content, run as a separate non-root user (`pwuser`) with the provided `seccomp_profile.json`. | Confirmed | `playwright.dev/docs/docker` | Sandbox containers run as `pwuser` with the Playwright seccomp profile. Root is never used. |
| P2 | The image is "not recommended" for visiting untrusted websites. | Confirmed | `playwright.dev/docs/docker` | Egress is allow-listed to the project's environment hosts only. Arbitrary browsing is out of scope. |
| P3 | `--ipc=host` is recommended for Chromium to avoid out-of-memory crashes. `--init` is recommended to reap zombie processes. | Confirmed | `playwright.dev/docs/docker` | We use `--init` and **`--shm-size=1g` instead of `--ipc=host`**, so IPC namespace isolation is kept. Spike `T-P0-04` checks stability. Assumption AS-07. |
| P4 | The image tag must match the project's `@playwright/test` version exactly (e.g. `v1.64.1-noble`). Alpine/musl is unsupported. | Confirmed | `playwright.dev/docs/docker` | The execution controller resolves the image tag from the test repository's lockfile and caches images per version. |
| P5 | Playwright Test Agents (planner, generator, healer) have shipped since v1.56. `npx playwright init-agents --loop=claude` generates agent definitions for Claude Code. | Confirmed | `playwright.dev/docs/test-agents` | Used only inside the code-generation sandbox. **The healer may only propose changes**: its output goes to a PR and is never committed to the default branch ([15 §6](15-ai-agent-architecture.md)). |
| P6 | Playwright offers `toHaveScreenshot()` with thresholds, masks, and animation disabling. | Confirmed (core documented API) | playwright.dev | It is the visual-regression comparison primitive in [17 §10](17-test-execution-engine.md). Baselines are stored in QualityOS, not only in Git. |

## 6. Object storage

| # | Claim | Status | Source | Design consequence |
|---|---|---|---|---|
| S1 | MinIO Community Edition stopped publishing binaries and Docker images in October 2025. Its repository went into maintenance mode in December 2025. | Confirmed by multiple independent sources (InfoQ, Linuxiac, project README quotes) | infoq.com 2025-12 | MinIO is **rejected** ([ADR-0011](adr/ADR-0011-object-storage.md)). Pilot uses the local filesystem adapter. Enterprise uses an S3-compatible adapter targeting whatever company infrastructure provides (Ceph RGW, Garage, SeaweedFS, AWS S3) or a future Azure Blob adapter. |

## 7. Runtime / frameworks

| # | Claim | Status | Source | Design consequence |
|---|---|---|---|---|
| R1 | Node.js 26 entered Active LTS on 2026-10-28. Node 24 is LTS. Node 20 reached end-of-life on 2026-04-30. | Confirmed (Node release schedule, reported) | nodejs.org | **Target Node 24 LTS** for maximum library compatibility in P1. Re-evaluate Node 26 in P11 (AS-03). |
| R2 | NestJS 12 shipped in Oct 2026: ESM-first, Standard Schema validation, rebuilt CLI, TypeScript 6. | Third-party (InfoQ) | infoq.com 2026-10 | Use NestJS 12 if `T-P0-05` confirms ecosystem compatibility (pg-boss, Drizzle, OpenTelemetry). Otherwise use NestJS 11 and plan an upgrade. Both are acceptable. Module boundaries do not depend on the version. |
| R3 | pgvector is a widely packaged Postgres extension that provides vector similarity indexes (HNSW, IVFFlat). | Confirmed (well-established) | github.com/pgvector/pgvector | Used for duplicate detection of requirements and defects. Use the `pgvector/pgvector:pg17` image locally. Enterprise must confirm whether a managed Postgres allows the extension (OD-06). |

## 8. Local connectivity

| # | Claim | Status | Design consequence |
|---|---|---|---|
| L1 | A local machine behind NAT cannot receive webhooks without a tunnel or relay. | Confirmed (network fact) | **Polling-first** ingress ([ADR-0014](adr/ADR-0014-polling-first-ingress.md)). Optionally, a tunnel such as Cloudflare Tunnel exposes only `/webhooks/*`. |
| L2 | A sleeping laptop misses webhook deliveries. Providers retry for limited windows only. | Confirmed (general behavior; retry windows vary by provider) | Reconciliation polling catches up after sleep, so missed webhooks never lose data. |

## 9. Items still to validate (Phase 0 spikes)

| Spike | Question | Exit criterion |
|---|---|---|
| T-P0-01 | Which parser stack works best on AR/EN DOCX/PDF/XLSX, including scanned PDFs: Docling vs Apache Tika vs unstructured, with Tesseract `ara+eng`? | Reaches the [14 §7](14-requirements-engine.md) quality targets on a 30-file sample corpus |
| T-P0-02 | Is pg-boss 12 + Drizzle transactional send workable in NestJS? | Prototype commits domain row + job atomically, and rollback leaves no job |
| T-P0-03 | Does n8n CE support the public API, `/healthz`, CLI import of stable IDs, and webhook HMAC verification via a Code node? | Documented answers, plus a working round-trip workflow |
| T-P0-04 | Is a Playwright sandbox (pwuser + seccomp + `--shm-size` + read-only rootfs + egress proxy) stable on the developer machine (Windows 11 + Docker Desktop/WSL2)? | 50 consecutive sample runs with no sandbox-caused failures |
| T-P0-05 | What are the exact versions (Node, NestJS, Next.js, Drizzle, pg-boss, Playwright) and are they compatible? | `docs/planning/36` updated with pinned versions |
| T-P0-06 | Can Claude's structured output follow the JSON Schema needed for tasks like `requirements.extract`, and what is the cost per document? | Schema-valid output in ≥ 95% of 50 calls; cost measured |

## 9a. Phase 0 results log
| Spike | Date | Outcome |
|---|---|---|
| T-P0-05 (registry part) | 2026-11-09 | Pins: Node 24 LTS; NestJS 12.4 (**OD-09 provisionally → 12**, final after T-P0-02); **TypeScript 6.0.3** (Nest CLI requires ~6.0.2, so TS 7 is not used yet); pnpm 12.18; Next 16.4 / React 19.3; Drizzle ORM 0.45.4 (**Apache-2.0**) + drizzle-kit 0.31.11; pg-boss 12.38.1; Zod 4.6; Playwright 1.65.0 with sandbox images for v1.63.0–v1.65.0 (noble); Postgres `pgvector/pgvector:0.8.7-pg17`; n8n **2.46.6** (= `stable`); parser on Python 3.12 (`unstructured` excludes 3.14). Open: socket-proxy and Squid images have no semver tags, so pin by digest or build a minimal image (T-P0-04). Details: `spikes/versions/RESULTS.md` |
| T-P0-01 (corpus) | 2026-11-09 | 28/30 synthetic EN/AR files with exact gold are generated (`spikes/parser/corpus`). The 2 Arabic scans are pending in-container. **Finding:** the text layer of a correctly shaped Arabic PDF splits the lam-alef ligature and reorders mixed-direction tokens (`FR-2` → `-2FR`). So PDF scoring and the quote-grounding validator ([15 §4](15-ai-agent-architecture.md)) must use Arabic-aware normalized matching, not raw substrings. Parser comparison is pending Docker |
| T-P0-01 (host bake-off) | 2026-11-09 | Docling 2.149 / torch 2.15 / RapidOCR on host Python 3.14. **DOCX/XLSX/CSV (EN+AR) and EN PDF: 100% exact text, tables intact, page locators 21/22.** **Arabic PDF is weak:** diacritic-bearing letters split off words (`تُظهر` → `ت … ُظهر`), giving AC fuzzy recall 10/24, and table cells come out in visual word order (a PDF-only RTL fix helps slightly). pdfplumber fails on Arabic (2/21) and does no OCR, so it is rejected. English scans via RapidOCR: 12/16 requirements. OCR models download at runtime from modelscope.cn, so they **must be baked into the parser image** (ADR-0013 no-egress). CPU speed ~20–25 s per 1-page PDF, mostly model load, so warm-service measurement is needed for NFR-PERF-05. Upload pre-validation prototype rejects all 4 hostile files and accepts all 24 valid ones. **OD-02 provisional: Docling primary + format-aware RTL post-processor.** Arabic PDF routing and Arabic OCR (Tesseract `ara` vs EasyOCR) still to be decided in the Docker run. Details: `spikes/parser/bakeoff/RESULTS.md` |
| T-P0-01 (Arabic follow-up) | 2026-11-10 | **PDFium page text is far better on Arabic PDFs than Docling's default backend** (AC exact 20/24 vs 5/24; req exact 17/21 vs 12/21) but has no table structure. Docling's own pypdfium2 backend is worse (req exact 5/21), so the adapter must merge Docling structure with PDFium text (P3). **Arabic OCR:** EasyOCR `ar+en` reaches 96% word recall on 2 scans; with right-to-left line ordering 9/10 requirements and 6/11 ACs match. Scanned Arabic stays review-forced. Details: `spikes/parser/bakeoff/RESULTS.md` |
| T-P0-02 | 2026-11-10 | **5/5 PASS** on embedded PostgreSQL 18.6 (no Docker): transactional `send` through `fromDrizzle(tx)` commits and rolls back with the domain row; `stately` dedupes on `singletonKey`; an uncompleted job is redelivered after expiry (at-least-once confirmed); `key_strict_fifo` keeps order. **OD-09 stays NestJS 12**; Nest wiring is proven in T-P1-06. To repeat on the pg17 image |
| T-P0-03 | 2026-11-10 | Native npm n8n 2.46.6 with SQLite (not the Docker image). **N4 confirmed:** `import:workflow --separate` with a fixed id overwrites without duplicating; `export:workflow --backup` round-trips. **N5 resolved:** the public REST API exists on CE (401 without a key; keyed calls untested). **N6:** `/healthz/readiness` is the correct probe (503 during migrations while `/healthz` is already 200). Activation is now `publish:workflow` and needs an n8n restart. HMAC verification in a Code node works with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`. To repeat on Docker with Postgres |
| Environment | 2026-11-10 | Docker and WSL are still not installed (needs the owner: admin rights and licence acceptance). **T-P0-04 (sandbox) is the only spike not run at all.** T-P0-06 is blocked until the owner sets `ANTHROPIC_API_KEY`. C: now has about 16 GB free |
| T-P0-04 | 2026-11-10 | **50/50 hardened sandbox runs pass**, 0 OOM, about 7 s per run (Docker Desktop 4.99, Engine 29.9.3, Playwright image v1.65.0-noble, Chromium only, one run at a time). Non-root + seccomp + read-only rootfs + cap-drop ALL works; egress allow-list through Squid works (403 for other hosts); no socket, no direct network. **Security finding:** `docker-socket-proxy` allows creating a privileged, host-mounting container (it filters paths, not bodies) → new task T-P6-24 and a note in ADR-0010. Details: `spikes/sandbox/RESULTS.md` |
| T-P0-02 / T-P0-03 (Docker reruns) | 2026-11-10 | pg-boss spike 5/5 on `pgvector/pgvector:0.8.7-pg17` (PG 17.11). n8n checks repeat on `n8nio/n8n:2.46.6` + Postgres. **New:** n8n 2.x blocks `$env` in Code nodes by default; the HMAC node needs `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, which exposes all env vars to workflows. Prefer a credential-based secret or verification outside n8n (decide in P7) |
| T-P0-06 | 2026-11-10 | Run on **Gemini** instead of Claude (owner decision, ADR-0019). `gemini-3.5-flash`: 12/12 schema-valid, 45/45 verbatim quotes, injection ignored 3/3, 10–26 s per call. `gemini-3.5-flash-lite`: 12/12 schema-valid, 35/37 quotes. `gemini-3.8-flash` unusable on the free tier (503, timeouts, 429). **Not measured:** cost (free tier), embeddings, Claude comparison. Details: `spikes/ai/RESULTS.md` |
| Environment | 2026-11-10 (end) | **All six P0 spikes have run.** Open for the P0 gate: owner confirmation of OD-02 and OD-09. Not run: Tika/unstructured comparison, warm parser service speed, parallel sandbox runs, embeddings |
| **P0 gate** | 2026-11-10 | **Closed.** Owner confirmed OD-02 and OD-09 in chat. Record: `docs/status/gates/P0.md`. P1 may start |
| Environment | 2026-11-09 | Host: 12 CPUs, 15.7 GB RAM, **C: 4 GB free**, D: 62 GB; **Docker not installed**. On that date T-P0-01/02/03/04 were blocked until Docker Desktop is installed, with its data on D:. T-P0-06 is blocked until the owner sets `ANTHROPIC_API_KEY` |

## 10. Reference list

| Source | Used for | Checked |
|---|---|---|
| n8n LICENSE.md (GitHub) | N1, N2 | 2026-11-09 |
| docs.n8n.io — Community edition features | N3 | 2026-11-08 |
| docs.n8n.io — Backup and restore (CLI) | N4 | 2026-11-08 |
| learn.microsoft.com — Azure DevOps OAuth (deprecation) | A1 | 2026-11-08 |
| learn.microsoft.com — Entra authentication for Azure DevOps | A2 | 2026-11-09 |
| learn.microsoft.com — Manage PATs with policies | A3 | 2026-11-09 |
| devblogs.microsoft.com — Retirement of global PATs | A4 | 2026-11-09 |
| learn.microsoft.com — Service hooks: Web Hooks | A5 | 2026-11-08 |
| pgboss.io (home, /api/jobs, /api/queues); github.com/timgit/pg-boss | Q1–Q7 | 2026-11-09 |
| playwright.dev/docs/docker | P1–P4 | 2026-11-09 |
| playwright.dev/docs/test-agents | P5 | 2026-11-08 |
| InfoQ (2025-12) — MinIO alternatives | S1 | 2026-11-08 |
| InfoQ (2026-10) — NestJS 12 | R2 | 2026-11-08 |
| Node.js release announcements | R1 | 2026-11-08 |
