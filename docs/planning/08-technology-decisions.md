# 08 — Technology Decisions

> Status: **Planned** · Owner: Principal Architect · Validation: [36](36-technical-validation.md) · Exact versions are pinned in Phase 0 (T-P0-05). The versions below are targets, not verified pins.

## 1. Final stack

| Layer | Choice | Target version | Why | Key alternative(s) |
|---|---|---|---|---|
| Language | TypeScript (strict) | **6.0.3** (pinned in T-P0-05: `@nestjs/cli@12` depends on `~6.0.2`; TS 7 not adopted yet) | One language across UI, API, tests, and contracts | — |
| Runtime | Node.js LTS | **24 LTS** (re-evaluate 26 in P11) | Library compatibility; pg-boss needs ≥ 22.12 | Bun (not chosen; ecosystem risk) |
| Monorepo | pnpm workspaces + Turborepo | latest stable | Strict deps, caching | Nx |
| Backend | NestJS on Fastify adapter | 12 (fallback 11) | DI, modules, guards, testing ([ADR-0004](adr/ADR-0004-nestjs-backend.md)) | Fastify-only, .NET |
| Validation/contracts | Zod (Standard Schema) | latest | Shared schemas, OpenAPI generation, AI output schemas | Valibot, TypeBox |
| Database | PostgreSQL + pgvector | **17** (`pgvector/pgvector:pg17`) | Single source of truth ([ADR-0005](adr/ADR-0005-postgres-drizzle.md)) | — |
| ORM / migrations | Drizzle ORM + drizzle-kit | latest stable | SQL-first, typed, transactional pg-boss adapter | Prisma, Kysely |
| Job queue | pg-boss | **12.x** | Transactional enqueue, queue policies, DLQ, cron ([ADR-0006](adr/ADR-0006-pg-boss-queue.md)) | BullMQ + Redis |
| Workflow orchestration | n8n (self-hosted CE, Docker) | pin a current 1.x/2.x stable at P0 | Owner requirement; behind a port ([ADR-0008](adr/ADR-0008-n8n-orchestrator.md)) | Temporal, Windmill |
| Frontend | Next.js App Router + React | current stable | SSR + streaming dashboards, ecosystem ([ADR-0016](adr/ADR-0016-nextjs-ui-only.md)) | Vite SPA, Remix |
| UI kit | Tailwind CSS v4 + shadcn/ui (Radix primitives) + custom token layer | latest | Accessible primitives, full design control (not a template look) | MUI, Mantine |
| Data fetching / tables | TanStack Query, TanStack Table, TanStack Virtual | latest | Dense, virtualized data grids | AG Grid Community |
| Charts | Recharts or visx (choose in P10 by bundle and a11y) | — | Theming, accessibility | ECharts |
| i18n | next-intl (ICU) | latest | RTL + Arabic plurals | i18next |
| Editor (rich text) | TipTap (ProseMirror) | latest | Structured requirements/test descriptions; RTL support | Lexical |
| Test engine | Playwright Test | match per test repo; sandbox images for the supported set (e.g. 1.6x) | Owner requirement; traces, visual compare, agents | Cypress (future engine adapter) |
| Execution isolation | Docker Engine (Desktop in pilot) + Tecnativa-style docker-socket-proxy + Squid/tinyproxy egress proxy | pin at P0 | [ADR-0010](adr/ADR-0010-sandboxed-execution.md) | gVisor, K8s Jobs (enterprise) |
| Document parsing | Python 3.12 + FastAPI + library chosen in T-P0-01 (Docling / Tika / unstructured) + Tesseract `ara+eng` | pin at P0 | [ADR-0013](adr/ADR-0013-python-parser-sidecar.md) | Node-only parsing (rejected) |
| AI providers | **Gemini (first, pilot; [ADR-0019](adr/ADR-0019-pilot-ai-provider-gemini.md))**; Anthropic Claude (second); OpenAI; OpenAI-compatible local (Ollama/vLLM) | current models via config | [ADR-0012](adr/ADR-0012-ai-gateway-bounded-tasks.md) | — |
| Embeddings | Provider embeddings via `AIProvider.embed` (configurable), or a local embedding model on the OpenAI-compatible adapter | — | Duplicate detection | Trigram-only fallback (OD-06) |
| Object storage | localfs adapter → S3-compatible adapter | — | MinIO rejected ([ADR-0011](adr/ADR-0011-object-storage.md)) | Azure Blob adapter (future) |
| Auth | Local (argon2id, TOTP) → OIDC (openid-client) | — | [ADR-0015](adr/ADR-0015-authentication.md) | Keycloak (unnecessary in pilot) |
| Observability | pino (JSON logs), OpenTelemetry SDK, optional Jaeger + Prometheus + Grafana compose profile | — | Standard, vendor-neutral | — |
| Testing (of QualityOS) | Vitest (unit/integration), Testcontainers (Postgres), Playwright (E2E of QualityOS UI), Pact-style contract suites implemented as shared Vitest suites, k6 (perf) | — | [24](24-testing-strategy.md) | Jest |
| Code quality | ESLint (flat config), Prettier, dependency-cruiser, Knip (unused), commitlint | — | Fitness functions | — |
| Security scanning | OSV-Scanner / npm audit, pip-audit, Trivy (images), Gitleaks (secrets) | — | NFR-SEC-07 | Snyk (commercial) |
| Local tunnel (optional) | Cloudflare Tunnel (or ngrok/Tailscale Funnel), restricted to `/webhooks/*` | — | [ADR-0014](adr/ADR-0014-polling-first-ingress.md) | smee.io (GitHub only) |
| Dev email | Mailpit (compose profile) | — | Test notifications locally | — |

## 2. Decision matrix: backend framework (weighted)
| Criterion (weight) | NestJS | Fastify + DIY | .NET 9/10 | Hono |
|---|---|---|---|---|
| Modularity & DI (5) | 5 | 3 | 5 | 2 |
| Shared language with UI/tests (4) | 5 | 5 | 1 | 5 |
| Enterprise maintainability (4) | 4 | 3 | 5 | 2 |
| Solo dev velocity (4) | 4 | 3 | 3 | 4 |
| Ecosystem for pg-boss/Drizzle/OTel (3) | 4 | 4 | 2 | 3 |
| Performance (2) | 4 | 5 | 5 | 5 |
| **Weighted total** | **97** | 81 | 77 | 73 |

## 3. Decision matrix: queue
| Criterion (weight) | pg-boss | BullMQ + Redis | Graphile Worker | Temporal |
|---|---|---|---|---|
| Atomic enqueue with domain TX (5) | 5 | 1 | 5 | 2 |
| Operational simplicity (5) | 5 | 3 | 5 | 1 |
| Features (policies, DLQ, cron) (4) | 4 | 5 | 3 | 5 |
| Throughput headroom (2) | 3 | 5 | 3 | 5 |
| Observability (SQL-visible) (2) | 5 | 3 | 4 | 4 |
| **Weighted total** | **82** | 56 | 76 | 53 |

## 4. Decision matrix: object storage (pilot → enterprise)
| Option | Pilot fit | Enterprise fit | Ops cost | Status |
|---|---|---|---|---|
| localfs adapter | ★★★ | ★ | none | **Chosen (pilot)** |
| S3-compatible (company-provided) | ★ | ★★★ | owned by IT | **Chosen (enterprise)** |
| MinIO CE | ★★ | ✗ | rising (source-only, maintenance mode) | Rejected |
| Garage / SeaweedFS (self-run) | ★★ | ★★ | medium | Allowed via S3 adapter if IT prefers |

## 5. Trade-offs accepted
| Decision | Accepted cost | Why acceptable |
|---|---|---|
| Postgres for queue + data | Shared load on one DB | Low volume; monitoring; port allows swap |
| Python parser sidecar | Second runtime | Quality of extraction outweighs; isolated & small |
| n8n as separate runtime | Two systems to operate; license question for company | Owner requirement; strict ownership model; replaceable port |
| Docker sandbox in pilot | Docker Desktop dependency on Windows | Security baseline is non-negotiable |
| No microservices | Single deployable couples release cadence | Team of one; extractable later |

## 6. Licensing summary
| Component | License (as generally published) | Note |
|---|---|---|
| PostgreSQL | PostgreSQL License | Permissive |
| pgvector | PostgreSQL License | Permissive |
| pg-boss | MIT | Permissive |
| NestJS, Next.js, React, drizzle-kit, Zod, TanStack, Radix, shadcn/ui, Tailwind | MIT | Permissive |
| Playwright, drizzle-orm, TypeScript | Apache-2.0 | Permissive (drizzle-orm corrected from MIT after T-P0-05) |
| n8n | **Sustainable Use License** (+ `.ee.` enterprise files) | Internal business use permitted; company use **pending legal (OD-01)**; no redistribution by QualityOS |
| Docling (if chosen) | MIT (verify at P0) | — |
| Apache Tika | Apache-2.0 | — |
| Tesseract | Apache-2.0 | — |
| Squid | GPL-2.0 (used as a separate unmodified container) | No linking; fine for internal use |
| Trivy, OSV-Scanner, Gitleaks | Apache-2.0 / MIT | Tools only |
> Every license is re-verified at P0 (T-P0-05) and recorded in `docs/planning/36`. QualityOS itself is proprietary/internal unless the owner decides otherwise.

## 7. Running cost model (pilot)
| Item | Cost | Basis |
|---|---|---|
| Infrastructure | USD 0 | Existing machine |
| AI | ≤ budget (default USD 50/month) | Ledger-enforced; actual measured in pilot |
| GitHub/Azure DevOps | USD 0 (personal free tiers assumed) | Verify personal plan limits |
| Electricity/time | not monetized | — |
> The enterprise cost model template is in [29 §6](29-business-case-and-kpis.md).

## 8. Version compatibility checklist (executed in T-P0-05)
- [ ] Node 24 LTS works with NestJS (11 or 12), Drizzle, pg-boss 12 (needs ≥ 22.12), OpenTelemetry SDK, and Next.js.
- [ ] pg-boss 12 Drizzle adapter works with the chosen Drizzle version.
- [ ] Postgres 17 with the pgvector image tag available.
- [ ] Playwright images exist for the set of supported versions, and the sandbox image builds for each (plus Arabic fonts).
- [ ] The n8n version supports CLI export/import as documented, and supports Code-node crypto for HMAC verification.
- [ ] Python parser library works on linux/amd64 and arm64 (for Apple Silicon contributors).
- [ ] Docker Desktop on Windows: the egress proxy network config works under WSL2.
