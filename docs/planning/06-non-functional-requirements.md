# 06 — Non-Functional Requirements

> Status: **Planned** · Owner: Principal Architect · Last reviewed: 2026-11-09

Targets apply to the **pilot** (single machine, AS-02) unless marked **[E]** (enterprise server). Each NFR names its verification method.

## Performance (PERF)
| ID | Requirement | Verification |
|---|---|---|
| NFR-PERF-01 | Interactive API p95 ≤ 300 ms, p99 ≤ 1 s for reads up to 100 items. Measured with 5 concurrent users in the pilot and 50 **[E]**. | Load test (P11) |
| NFR-PERF-02 | Dashboard summary p95 ≤ 500 ms with 50 projects and 1M test results. | Large-seed perf test |
| NFR-PERF-03 | Step-runner status persistence ≤ 1 s round trip. | E2E timing |
| NFR-PERF-04 | Sandbox start overhead ≤ 20 s with a warm image cache, excluding `npm ci`. Dependency cache keyed by lockfile hash. | Controller metrics |
| NFR-PERF-05 | Document parse of a 50-page digital PDF ≤ 60 s. Scanned: ≤ 10 s per page. | Parser benchmark |
| NFR-PERF-06 | Outbox event to n8n dispatch latency p95 ≤ 5 s while healthy. | Metrics |
| NFR-PERF-07 | Run result visibility: a finalized run's results appear in the UI ≤ 10 s after its containers exit. | E2E |

## Scalability (SCAL)
| ID | Requirement |
|---|---|
| NFR-SCAL-01 | Logical limits: unlimited projects. Capacity planning target **[E]**: 100 projects, 200 users, 50k test cases, 5M results/year, 2 TB artifacts/year with retention. |
| NFR-SCAL-02 | `worker` and `execution-controller` scale horizontally: multiple instances coordinate through pg-boss (SKIP LOCKED) and controller leases. |
| NFR-SCAL-03 | Pilot run parallelism defaults to 2 concurrent sandboxes (16 GB RAM machine), configurable. **[E]** Scales by adding runner hosts or the CI backend. |
| NFR-SCAL-04 | Large tables (`test_results`, `execution_attempts`, `audit_events`, `artifacts`, `ai_executions`) are designed for monthly range partitioning when volume crosses about 20M rows ([10 §9](10-database-design.md)). |

## Availability & reliability (REL)
| ID | Requirement |
|---|---|
| NFR-REL-01 | Pilot: best-effort availability. After a restart, the system recovers with **no data loss and no stuck states** within 2 min of the processes coming back. |
| NFR-REL-02 | **[E]** 99.5% monthly availability in business hours. RPO ≤ 24 h (daily backups plus optional WAL archiving gives RPO ≤ 15 min). RTO ≤ 4 h. |
| NFR-REL-03 | Every background consumer is idempotent under at-least-once delivery ([22 §4](22-observability-and-reliability.md)). |
| NFR-REL-04 | No run stays in `running` longer than its timeout plus 5 min (reaper guarantee). |
| NFR-REL-05 | An n8n outage never loses events or schedule slots: O-F falls back and O queues ([18](18-n8n-orchestration.md)). |
| NFR-REL-06 | Backups are verified by an automated restore at least weekly. |

## Security (SEC)
Detailed controls are in [21](21-security-architecture.md).

| ID | Requirement |
|---|---|
| NFR-SEC-01 | Authentication is required for every endpoint except health and liveness and the signature- or secret-verified webhook endpoints. |
| NFR-SEC-02 | Authorization is deny-by-default and project-scoped, and every route declares its permission. |
| NFR-SEC-03 | Secrets are encrypted at rest with envelope encryption. They are never logged or returned, and never sent to AI. |
| NFR-SEC-04 | Untrusted code (test repositories, generated code) runs only in hardened sandboxes. |
| NFR-SEC-05 | External mutations go through approval policies and are audited. |
| NFR-SEC-06 | OWASP ASVS Level 2 controls are applicable to the web app and API. Selected controls are verified in P11. |
| NFR-SEC-07 | Dependencies are scanned in CI (npm audit / OSV, pip-audit) and container images scanned (Trivy). Critical vulnerabilities block release. |
| NFR-SEC-08 | TLS: in the pilot, `localhost` HTTP is acceptable; any webhook exposure through a tunnel must be HTTPS. **[E]** TLS 1.2+ everywhere, HSTS. |

## Privacy & compliance (PRIV)
| ID | Requirement |
|---|---|
| NFR-PRIV-01 | AI data minimization: only task-relevant, redacted content is sent. Each project has an explicit AI data-sharing consent setting. |
| NFR-PRIV-02 | Retention policies are configurable per data class, with legal hold. |
| NFR-PRIV-03 | Personal data export and deletion are supported per user (M14-FR-13). |
| NFR-PRIV-04 | No company data is used in the pilot (AS-04). |

## Usability & accessibility (UX/A11Y)
| ID | Requirement |
|---|---|
| NFR-UX-01 | WCAG 2.2 AA for all core screens: keyboard operability, focus visibility, contrast ≥ 4.5:1 for text, labels. |
| NFR-UX-02 | Every primary workflow (execute test, review suggestion, approve defect) is completable with the keyboard alone. |
| NFR-UX-03 | Supports RTL layout and Arabic UI strings (P10–P11) with no layout breakage (visual tests in both directions). |
| NFR-UX-04 | Supports light and dark themes with equal contrast compliance. |
| NFR-UX-05 | Responsive from 1280 px down to 768 px (tablet) for all screens. The step runner and approvals inbox are usable at 390 px (phone). |

## Maintainability (MAINT)
| ID | Requirement |
|---|---|
| NFR-MAINT-01 | Module boundaries are enforced by dependency-cruiser in CI. Domain packages have zero framework imports. |
| NFR-MAINT-02 | Test coverage: domain ≥ 90% lines, application services ≥ 80%, adapters covered by contract suites. |
| NFR-MAINT-03 | Every API is described by Zod schemas in `@qos/contracts`, with OpenAPI generated and published at `/api/docs` (auth required). |
| NFR-MAINT-04 | ADRs are required for decisions that meet the ADR criteria ([adr/README](adr/README.md)). |
| NFR-MAINT-05 | Migrations are forward-only and reviewed. Destructive migrations require a two-step expand/contract process. |

## Portability (PORT)
| ID | Requirement |
|---|---|
| NFR-PORT-01 | Runs on Windows 11 (Docker Desktop with WSL2), macOS, and Linux with Docker Compose. |
| NFR-PORT-02 | No cloud-provider-specific service is required. Every external dependency sits behind a port. |
| NFR-PORT-03 | **[E]** Deployable to a Linux server with Docker Compose. Kubernetes is optional (Helm chart in P13+ only if company IT requires it). |

## Observability (OBS)
| ID | Requirement |
|---|---|
| NFR-OBS-01 | Structured JSON logs with a correlation ID across api, worker, controller, parser, and n8n callbacks. |
| NFR-OBS-02 | OpenTelemetry traces for HTTP and job processing. The exporter is optional locally (console or Jaeger). |
| NFR-OBS-03 | Metrics: request rates and latencies, queue depth per queue, DLQ size, run durations, sandbox resource use, AI tokens and cost, sync lag per binding. |
| NFR-OBS-04 | Health endpoints: `/healthz` (liveness) and `/readyz` (dependencies) per process. |

## Cost (COST)
| ID | Requirement |
|---|---|
| NFR-COST-01 | The pilot's infrastructure cost is zero beyond the existing machine. AI spend stays within its budget (default USD 50/month, AS-17). |
| NFR-COST-02 | Every AI call is metered, attributed to a project, task, and user, and capped by budgets. |
| NFR-COST-03 | Artifact storage growth is bounded by retention and reported per project. |

## Internationalization (I18N)
| ID | Requirement |
|---|---|
| NFR-I18N-01 | All UI strings are externalized (ICU messages). Dates, numbers, and plurals are locale-aware. |
| NFR-I18N-02 | The data layer stores and searches Arabic text correctly (UTF-8, Arabic normalization for search). |
