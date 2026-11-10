# 31 — Assumptions and Open Decisions

> Status: **Planned** · Owner: Principal Architect + Product Manager · Last reviewed: 2026-11-09

These are the assumptions the plan was built on, as the brief's Rule 10 asks. If an assumption turns out to be false, the "If wrong" column shows how much of the plan has to change. Open decisions need a named decider and a deadline, which is a phase gate.

## 1. Assumptions

| ID | Assumption | Basis | If wrong | Validated by |
|---|---|---|---|---|
| AS-01 | One developer (the owner) builds and runs the pilot. Claude Code sessions help. | Brief §2 | Roadmap timing changes. The architecture does not. | n/a |
| AS-02 | The pilot machine is Windows 11 with Docker Desktop (WSL2 backend), at least 16 GB RAM, ideally 32 GB, and at least 8 logical CPUs. | Environment observed (win32) | The resource budget in [23](23-local-deployment.md) shrinks: run parallelism 1, n8n optional. | T-P0-04 |
| AS-03 | Node 24 LTS is the baseline runtime. Node 26 LTS is adopted in P11 after the libraries confirm support. | [36 R1](36-technical-validation.md) | Minor. The runtime is pinned in `.nvmrc` / `engines`. | T-P0-05 |
| AS-04 | Pilot data is the owner's personal projects and synthetic data only. No company code, data, or credentials are used. | Brief §12 | **Blocking**: a security and legal review would be needed first. | Pilot checklist [27](27-pilot-validation-plan.md) |
| AS-05 | One organization in the pilot. Company rollout is single-organization (one company) with many projects and teams. | Brief §4 | Multi-organization is supported in the schema (`organization_id` on root aggregates). Exposing it is a P13+ feature. | n/a |
| AS-06 | The pilot AI provider API (Gemini free tier, ADR-0019) is reachable from the pilot machine, and the owner accepts sending *redacted* personal-project content to it. No company or confidential data on the free tier. | Brief §6 | Use the OpenAI-compatible adapter pointed at a local model, with lower quality. | T-P0-06 |
| AS-07 | `--shm-size=1g` gives enough shared memory for Chromium without `--ipc=host`. | [36 P3](36-technical-validation.md) | Enable `--ipc=host` per project as an explicit, audited policy exception. | T-P0-04 |
| AS-08 | Requirements documents are mostly digitally authored DOCX/PDF/XLSX. A minority are scanned. Arabic content is Modern Standard Arabic. | Brief §5 / M04 | OCR quality drops, and more human review is needed. Extraction confidence surfaces this. | T-P0-01 |
| AS-09 | Applications under test are web applications reachable over HTTP(S) from the sandbox network. Native mobile and desktop apps are out of scope until a `TestEngine` for them exists. | Brief (Playwright initially) | New engine adapter. The core does not change ([ADR-0018](adr/ADR-0018-test-engine-vs-execution-backend.md)). | n/a |
| AS-10 | Test code lives in Git. Default: a dedicated test repository per project. Optional: a folder in the app repository. | [ADR-0009](adr/ADR-0009-test-code-location.md) | n/a: both modes are designed. | n/a |
| AS-11 | A QA engineer spends ≥ 30% of their time on repetitive regression execution and bug-report writing. This is the baseline hypothesis to measure, not a fact. | Brief §16 | The business case is weaker. The pilot measures it ([27](27-pilot-validation-plan.md)). | P12 baseline |
| AS-12 | n8n runs in the same Docker Compose project as QualityOS and reaches the API over the internal network. | Brief §7 | Use mTLS or an API gateway if hosted separately (enterprise). | P7 |
| AS-13 | English UI first. Arabic UI strings follow in P10–P11. RTL layout support is built from P1 (logical CSS properties). | Brief §11 | n/a | P1 lint rule |
| AS-14 | Email notifications in the pilot go to a local catcher (Mailpit) or the owner's SMTP. Teams and Slack are optional n8n workflows. | Brief §7 | n/a | P7 |
| AS-15 | Company GitLab is self-managed (likely) or gitlab.com. Both are supported by a base-URL parameter. | Brief §2 | n/a | P13 |
| AS-16 | Company CI is GitLab CI. QualityOS integrates as a result consumer and optional trigger, and does not replace the company's CI. | Brief §3.4 | n/a | P13 |
| AS-17 | AI cost ceiling for the pilot: **USD 50/month default budget**, configurable. | Engineering judgment | Budget enforcement prevents surprises. | P5 |
| AS-18 | The test repository uses Node and `@playwright/test`. Other languages (Python or .NET Playwright) are future engine variants. | Simplicity | Engine adapter variant. | n/a |

## 2. Open decisions

| ID | Decision | Options | Recommendation | Decider | Deadline (gate) |
|---|---|---|---|---|---|
| OD-01 | **Is n8n CE allowed for company internal use?** | (a) CE under SUL; (b) n8n Business/Enterprise license; (c) replace with another orchestrator adapter | (a) if legal confirms. QualityOS never redistributes n8n. | Company legal + IT | Before P13 |
| OD-02 | Document parser stack | Docling, Apache Tika + Tesseract, unstructured | **Decided 2026-11-10 (owner confirmed at the P0 gate):** Docling primary; PDFium page text for Arabic PDFs; EasyOCR `ar+en` with RTL line ordering for Arabic scans. Tika/unstructured not run | Architect | End of P0 |
| OD-03 | Default test-code location for the company | dedicated QA repo vs in-app-repo folder | Dedicated QA repo ([ADR-0009](adr/ADR-0009-test-code-location.md)) | QA Lead + Dev leads | P13 |
| OD-04 | Company identity provider | Entra ID OIDC (likely), other OIDC | Entra ID OIDC | Company IT | P13 |
| OD-05 | Company secrets manager | Azure Key Vault, HashiCorp Vault, keep DB envelope encryption with an HSM-held key | Azure Key Vault if the company is on Azure | Company IT/Sec | P13 |
| OD-06 | Company Postgres: self-hosted vs managed, and whether pgvector is allowed | | Self-hosted Postgres 17 + pgvector, or managed with the extension. Fallback: use trigram similarity and drop pgvector ([09 §8](09-domain-model.md)). | Company IT | P13 |
| OD-07 | Company object storage | S3-compatible (Ceph RGW, etc.), Azure Blob | Use whatever IT already runs. Add the Azure Blob adapter if needed. | Company IT | P13 |
| OD-08 | Data residency and AI provider approval for confidential code | Approved cloud provider with enterprise terms, private endpoint, or local model | Formal AI data-processing review | Company Sec/Legal | Before any company data |
| OD-09 | NestJS 11 vs 12 | | **Decided 2026-11-10 (owner confirmed at the P0 gate): NestJS 12** (T-P0-05 pins pass; T-P0-02 passes on pg17). Nest wiring itself is proven in T-P1-06 | Architect | End of P0 |
| OD-10 | Whether to run Postgres RLS in production or keep it as a defence-in-depth test only | | Enable in P11 with `app.current_project_ids` session setting ([21 §4](21-security-architecture.md)) | Architect + Sec | P11 |
| OD-11 | Multi-organization exposure (SaaS-like) | | Not planned. Revisit only if the company wants to offer it to subsidiaries. | Product | Post-P13 |
| OD-12 | Remote runner pool technology for company scale | Docker hosts running runner agents, Kubernetes Jobs, CI-delegated | Start CI-delegated plus Docker host agents. K8s only if IT already runs it. | Platform Eng | P13 |

## 3. Explicit non-goals (for now)

- Load and performance testing engines (k6 and similar): an adapter slot exists, but none is planned before P13.
- Native mobile and desktop automation.
- Replacing the company's CI/CD system.
- Fully autonomous bug filing without human review. It can be configured per project for low-severity internal-tracker defects only, and it is off by default.
- Automatic healing of tests that changes assertions or baselines. This is never allowed.
- Public SaaS / multi-tenant billing.
