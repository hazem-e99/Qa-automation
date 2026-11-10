# T-P0-05 — Version pinning & licences (registry check)

> Checked 2026-11-09 against the npm registry, PyPI, Docker Hub and MCR. Image builds and runtime compatibility are verified inside T-P0-02 and T-P0-04.

## Decisions
| Item | Pin | Evidence | Note |
|---|---|---|---|
| Node.js | **24 LTS** (24.18.0 installed) | pg-boss needs ≥22.12; OTel sdk-node ≥22.15; testcontainers ≥22.22; vitest/dependency-cruiser support ^24 | Re-evaluate Node 26 in P11 (T-P11-04) |
| NestJS | **12.4.x** (`@nestjs/core`, `@nestjs/platform-fastify`), CLI 12.0.12 | engines `>=20`; peer `reflect-metadata`, `rxjs ^7.1` | **OD-09 → NestJS 12**, provisional until T-P0-02 proves pg-boss + Drizzle inside a Nest app context |
| TypeScript | **6.0.3** (not 7.0.2) | `@nestjs/cli@12` depends on `typescript ~6.0.2` | TS 7 (native compiler) is out but the Nest toolchain is on 6. Revisit after Nest moves |
| pnpm | **12.18.0** via `packageManager` | latest; engines ≥18 | Host has 9.15.9; use corepack in P1 |
| Turborepo | 2.11.x | — | — |
| Next.js / React | **16.4.x / 19.3.x** | engines ≥20.9 | — |
| Tailwind / next-intl / TanStack Query | 4.3.x / 4.14.x / 5.107.x | — | — |
| Zod | **4.6.x** | — | Standard Schema compatible |
| Drizzle | **drizzle-orm 0.45.4, drizzle-kit 0.31.11** | peer `pg >=8` | drizzle-orm licence is **Apache-2.0** (doc 08 said MIT, now corrected) |
| pg-boss | **12.38.1** | deps `pg ^8.23.1`, `cron-parser`, `rrule-temporal`; optional peer `@opentelemetry/api` | No separate Drizzle adapter package. Transactional send goes through the `db` option (`executeSql`), proven in T-P0-02 |
| pg | 8.23.x | — | — |
| Playwright | **1.65.0**; sandbox images supported set **v1.63.0, v1.64.0, v1.64.1, v1.65.0 (-noble)** | MCR tag list | Older test repos get `unsupported_engine_version` |
| Vitest / Testcontainers / dependency-cruiser | 5.1.x / 12.2.x / 18.7.x | engines OK on Node 24 | — |
| pino / OTel sdk-node | 10.4.x / 0.301.x | — | — |
| argon2 / openid-client | 0.45.x / 6.8.x | — | argon2 needs prebuilt binaries for Windows/Linux, checked in P1 |
| Anthropic SDK | `@anthropic-ai/sdk` 1.6.x | — | Model IDs come from config, verified in T-P0-06 |
| PostgreSQL | **`pgvector/pgvector:0.8.7-pg17`** | Docker Hub (amd64 + arm64) | Pin by digest in P1 compose |
| n8n | **`n8nio/n8n:2.46.6`** (= `stable` digest `sha256:8602f5df…`) | Docker Hub; npm `n8n` engines Node ≥24 | n8n is now on **2.x** (v3 nightlies exist). Template behaviour is checked in T-P0-03. The meaning of the `-pc` tag variants is unknown and gets checked in T-P0-03 |
| Parser runtime | **Python 3.12** container | `unstructured` requires `<3.14`; docling ≥3.10; FastAPI ≥3.10 | Host Python 3.14 is not used for the parser |
| Docling / unstructured / Tika | 2.149.0 (MIT) / 0.27.37 (Apache-2.0) / `apache/tika` 4.2.0-full | PyPI, Docker Hub | Compared in T-P0-01 |
| Socket proxy | **`tecnativa/docker-socket-proxy:v0.5.0`** (2026-07-27) | Docker Hub semver tags exist (a first query only returned PR tags) | Pin by digest in P1 |
| Egress proxy | `ubuntu/squid:6.6-24.04_edge` for the spike | ubuntu/squid publishes only `_edge`/`_beta` tags | **Finding:** no stable-track Squid image. T-P0-04 decides between pinning this by digest and building a minimal Debian+squid image |

## Licences
| Component | Licence |
|---|---|
| NestJS, Next.js, React, pg-boss, pg, Zod, TanStack, Tailwind, next-intl, pino, Vitest, Testcontainers, dependency-cruiser, argon2, openid-client, drizzle-kit, Turborepo, pnpm | MIT |
| drizzle-orm, Playwright, TypeScript, OpenTelemetry, Anthropic SDK, Apache Tika, unstructured, pytesseract | Apache-2.0 |
| Docling, FastAPI, python-docx, openpyxl | MIT |
| uvicorn | BSD-3-Clause |
| n8n | Sustainable Use License (+ `.ee.` files under the Enterprise licence). Company use still pending OD-01 |
