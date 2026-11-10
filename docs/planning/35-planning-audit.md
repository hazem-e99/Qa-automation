# 35 — Planning Audit

> Status: **Complete for planning stage** · Audit date: 2026-11-09 · Auditor role: independent architecture & product review (performed after the first full writing pass; findings fixed in place before declaring planning complete)

## 1. Method
1. **Automated consistency checks.** A read-only Node script, no dependencies, run over all `docs/planning/**/*.md` (§4).
2. **The 20 review questions from the brief (§21),** answered against the documents (§2).
3. **The owner's audit checklist:** provider coupling, missing workflows, overengineering, security, incomplete modules, contradictions, missing requirements or ACs or dependencies, unnecessary services, unrealistic automation, QA usability, operational costs (§3).
4. **Every finding** was either fixed in the documents or recorded as an open decision or risk (§5).

## 2. Brief §21 review questions
| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | Is the architecture genuinely provider-agnostic? | **Yes**, by design + enforced | Ports & capability manifests ([11](11-provider-architecture.md), [12](12-provider-contracts.md)); provider-literal lint & dependency rules ([07 §9](07-system-architecture.md)); ExternalRef model; mock adapters; contract suites |
| 2 | Can GitHub be switched to GitLab? | **Yes** | WF-F ([19](19-workflow-specifications.md)); binding history; ref mappings; GitLab adapter P13 passes the same contract suite; compatibility differences explicit ([33](33-provider-compatibility-matrix.md)) |
| 3 | Can Azure requirements be replaced with PDF/Word? | **Yes** | Document sources implement the same `RequirementsSource` port; identical downstream workflow (M04-AC-09) |
| 4 | Different providers per project simultaneously? | **Yes** | Per-project bindings; mixed-provider E2E (X-AC-12) |
| 5 | Manual and automated testing supported? | **Yes**, one model | [16 §1–2](16-test-management-engine.md); M06 manual-first value at P4 |
| 6 | Is n8n replaceable? | **Yes** | `WorkflowOrchestrator` port; Automation API contract; Null adapter; [18 §13](18-n8n-orchestration.md) |
| 7 | Can the platform work locally? | **Yes** | [23](23-local-deployment.md); demo mode with no credentials; polling-first ingress |
| 8 | Can it migrate to company infrastructure? | **Yes**, with listed adapters | [28 §1, §4](28-enterprise-rollout.md); same images; adapters P13 |
| 9 | Are integrations safe? | **Yes**, with residual risks | Least-privilege scopes ([13](13-integration-design.md)); verification + re-fetch; approval gates; SSRF guard; [21](21-security-architecture.md) |
| 10 | Are test results trustworthy? | **Designed to be** | Immutable runs; attempts never overwritten; flaky visible; pinned images; manifests; diff guard; baselines only via approval |
| 11 | Are AI responsibilities clearly bounded? | **Yes** | Task catalog; agentic only in sandbox; approvals ([15](15-ai-agent-architecture.md), [ADR-0012](adr/ADR-0012-ai-gateway-bounded-tasks.md)) |
| 12 | Are workflows resilient to failures? | **Yes** | At-least-once + idempotency; reconciliation; fallback scheduler; reaper ([17 §8](17-test-execution-engine.md), [18 §8](18-n8n-orchestration.md), [22](22-observability-and-reliability.md)) |
| 13 | Is the database extensible? | **Yes** | Schemas per module; typed JSONB settings with versions; ExternalRef; partition plan ([10](10-database-design.md)) |
| 14 | Are external identifiers handled safely? | **Yes** | `external_refs` with instance + version + snapshot; uniqueness; never raw IDs in domain tables |
| 15 | Are UX workflows practical for QA engineers? | **Mostly**; improved during audit | Keyboard-first runner, offline tolerance, quick modes added (M06-FR-15); validated in P4 with time measurement |
| 16 | Are reporting metrics well defined? | **Yes** | Exact formulas, provenance, min samples ([29](29-business-case-and-kpis.md)) |
| 17 | Is the roadmap realistic? | **Realistic only as a multi-month plan** | ~37 dev-weeks single-builder estimate before pilot ([25 §1](25-implementation-roadmap.md)); R-01 rated 16; value at P4 limits risk |
| 18 | Are acceptance criteria testable? | **Yes** | 111 module ACs + 12 cross-cutting, each mapped to a verification level ([32](32-acceptance-criteria-matrix.md)) |
| 19 | Resource and cost constraints considered? | **Yes** | Resource budget ([23 §5](23-local-deployment.md)); AI budgets; cost KPIs; operating cost model ([29 §6](29-business-case-and-kpis.md)) |
| 20 | Can a future team execute without rediscovering decisions? | **Yes** | 18 ADRs; 290+ tasks with verify criteria; kickoff instructions ([37](37-implementation-kickoff.md)); validation register ([36](36-technical-validation.md)) |

## 3. Owner checklist findings and fixes
| Area | Finding | Severity | Resolution |
|---|---|---|---|
| Provider coupling | BR-M04-8 named Azure Boards as authority in a core business rule | Medium | **Fixed**: reworded provider-neutral ("external requirements source"); adapter-specific behavior stays in [13](13-integration-design.md) |
| Provider coupling | Module specs list concrete adapters (e.g. "Azure Boards sync" feature) | Low | Accepted: features name pilot adapters as *examples*; rules and entities are neutral; lint applies to code, not docs |
| Contradiction | ADR-0010 said sandboxes `git clone` with a provider token; [17](17-test-execution-engine.md) used API-streamed archives; M03/M08 mentioned clone tokens | High | **Fixed**: default everywhere = commit archive streamed by API with per-run token; provider-minted tokens optional optimization; sandboxes never hold provider credentials |
| Contradiction | Fallback firing condition differed between ADR-0017/M11 and [18 §5](18-n8n-orchestration.md) (2× grace safety net) | Medium | **Fixed**: unified rule in ADR-0017, M11 BR-M11-2, 18 §5 |
| Contradiction | ADR-0006 pointed queue-policy table to doc 22 (it is in 17 §3) | Low | **Fixed** |
| Contradiction | M03 provider list implied Playwright/Docker/n8n adapters in P2 | Low | **Fixed**: adapters listed with their phases |
| Missing dependency | No task created the demo app needed by P6 execution, codegen evals, failure evals | High | **Fixed**: T-P6-23 added |
| Missing dependency | SSRF-safe HTTP client (used by every adapter) had no task | High | **Fixed**: T-P1-17 added |
| Missing requirement | General API rate limiting unspecified (only login/webhooks) | Medium | **Fixed**: [21 §5](21-security-architecture.md) + T-P1-18 |
| Missing dependency | Parser corpus assembly not explicit | Medium | **Fixed**: T-P0-01 now includes corpus assembly |
| Security | Sandbox can reach API internal listener — scope of that listener unspecified | High | **Fixed**: [17 §6](17-test-execution-engine.md) restricts listener to 4 sandbox routes with audience-bound tokens |
| Security | n8n editor account hardening unspecified | Medium | **Fixed**: [18 §10](18-n8n-orchestration.md) owner account + MFA check |
| Security | Single-person pilot conflicts with separation-of-duties default | Medium | **Fixed**: explicit, audited `allowSelfApproval` for single-member projects only; pilot checklist item ([27 §3](27-pilot-validation-plan.md)); must be off for teams |
| Security (residual) | npm `postinstall` scripts run inside sandbox (supply chain) | Medium | Accepted under isolation boundary; R-07; option of signed pre-built dependency images |
| Security (residual) | Codegen sandbox can spend its AI budget via gateway proxy on arbitrary prompts | Low | Accepted: per-job budget + step caps + audit; proxy only for codegen jobs |
| QA usability | Manual runner lacked fast paths for short/obvious cases | Medium | **Fixed**: M06-FR-15 quick modes (still step-level audit) |
| Overengineering | Many infra components (socket proxy, egress proxy, registry mirror, parser, n8n) | Medium | Reviewed: socket & egress proxies are security-necessary; registry mirror and observability stack are **optional profiles**; `core` profile is 6 services; no Redis/MinIO/K8s |
| Overengineering | Audit hash chain, RLS, custom roles, break-glass | Low | Deferred to P11 (not pilot-blocking); RLS remains an open decision (OD-10) |
| Unnecessary services | Verdaccio registry mirror | Low | Kept optional; enable only if measured `npm ci` time > 60 s per run |
| Unrealistic automation | Brief-style "90% automation" claims | — | Not claimed anywhere; KPIs measured; estimates labelled |
| Unrealistic automation | Codegen targets (compile ≥ 0.95, pass ≥ 0.80) may be optimistic | Medium | Kept as targets with eval gates; shortfall → documented decision at P9 gate; R-02 |
| Unrealistic effort | 150 labelled failures + 40-requirement eval sets are labor-intensive | Medium | Generated largely from demo-app toggles (seeded bugs/flaky/env outage) with human review; noted in T-P8-02 sizing (L) |
| Operational costs | Upgrade/patching and support effort missing from cost model | Low | **Fixed**: rows added in [29 §6](29-business-case-and-kpis.md) |
| Missing workflows | Checked brief Module 11's 14 workflows against templates | — | All 14 mapped ([18 §9](18-n8n-orchestration.md)); plus WF-G/H reference flows |
| Incomplete modules | Each module spec has the 18 mandatory sections | — | Verified automatically (§4) |
| Missing ACs | Every module has ACs; cross-cutting ACs added | — | 111 + 12 ([32](32-acceptance-criteria-matrix.md)) |
| Facts vs assumptions | Claims about Anthropic embeddings stated as checked | Medium | **Fixed**: marked Unverified (T-P0-06) in [13 §9](13-integration-design.md) |
| Facts vs assumptions | Repo layout line in 07 contained an unresolved design note | Low | **Fixed** |

## 4. Automated consistency checks (results after fixes)
Script checks (read-only, run 2026-11-09):
| Check | Result |
|---|---|
| Relative links resolve to existing files | Pass (after README/35 written) |
| Each module spec has 18 sections in template order | Pass (14/14) |
| Every task ID referenced anywhere exists in [26](26-task-breakdown.md) | Pass |
| Every module AC appears in [32](32-acceptance-criteria-matrix.md); every AC reference exists | Pass (111) |
| Mermaid fences balanced; diagram keyword valid | Pass |
| No untracked open-item markers (to-do / to-be-decided / fix-me) | Pass |
| ADR references within 0001–0018 | Pass |
| KPI references exist in [29](29-business-case-and-kpis.md) | Pass (25 KPIs) |
| OD/AS and risk references exist in [31](31-assumptions-and-open-decisions.md)/[30](30-risks-and-mitigations.md) | Pass |
| Nothing created outside `docs/planning/` | Pass (repository contains only `docs/planning/**`) |
> In P1 this script becomes `tools/docs-check` and runs in CI, so the docs, the AC matrix, and the task IDs stay consistent.

## 5. Coverage completeness
| Brief section | Covered in |
|---|---|
| §1–2 Vision, context, objectives | [01](01-executive-summary.md), [02](02-product-vision.md), [03](03-business-requirements.md) |
| §3 Provider agnosticism (all families) | [11](11-provider-architecture.md), [12](12-provider-contracts.md), [13](13-integration-design.md), [33](33-provider-compatibility-matrix.md), ADR-0002/0018 |
| §4 Multi-project/team | [09](09-domain-model.md), [10 §6](10-database-design.md), [M02](modules/M02-project-management.md), [M13](modules/M13-team-permissions.md) |
| §5 Modules 1–14 (17 aspects each) | [modules/](modules/) (18-section template) |
| §6 Workflows A–F | [19](19-workflow-specifications.md) (+G, H) |
| §7 n8n | [18](18-n8n-orchestration.md), ADR-0008/0017 |
| §8 AI agents | [15](15-ai-agent-architecture.md), ADR-0012 |
| §9 Tech stack | [08](08-technology-decisions.md), [36](36-technical-validation.md) |
| §10 Domain & DB | [09](09-domain-model.md), [10](10-database-design.md) |
| §11 UI/UX | [20](20-ui-ux-architecture.md) |
| §12 Security | [21](21-security-architecture.md) |
| §13 Reliability | [22](22-observability-and-reliability.md) |
| §14 Local deployment | [23](23-local-deployment.md) |
| §15 Testing | [24](24-testing-strategy.md) |
| §16 Pilot & business validation | [27](27-pilot-validation-plan.md), [29](29-business-case-and-kpis.md) |
| §17 Roadmap | [25](25-implementation-roadmap.md), [26](26-task-breakdown.md) |
| §18 Documentation & ADRs | This package; [adr/](adr/README.md) |
| §19 Research | [36](36-technical-validation.md) (sources & dates). Installed skills reviewed; no skill was necessary for authoring, and none were installed |
| §20 Rules | Planning only: no code, installs, containers, or external changes |
| Owner follow-up §2–§8 | Provider families incl. storage/orchestration/test engine ([11 §3](11-provider-architecture.md)); orchestration ownership ([18](18-n8n-orchestration.md), ADR-0017); queue vs execution separation ([17](17-test-execution-engine.md)); requirements model ([14](14-requirements-engine.md)); enterprise vision/personal execution ([28](28-enterprise-rollout.md)); validations ([36](36-technical-validation.md)) |

## 6. Unresolved decisions (carry into implementation)
See [31 §2](31-assumptions-and-open-decisions.md). Two are **blocking for company rollout**: OD-01 (n8n license) and OD-08 (AI data processing). OD-02 (parser) and OD-09 (NestJS version) are blocking for P1, and are resolved in P0.

## 7. High-risk assumptions
| Assumption | Why high-risk | Validation |
|---|---|---|
| AS-07 `--shm-size` suffices without `--ipc=host` | Chromium crashes would undermine trust | T-P0-04 (50-run stability) |
| AS-08 docs mostly digital; MSA Arabic | Extraction quality | T-P0-01 corpus metrics |
| AS-11 QA effort share on repetitive work | Business case depends on it | P12 baseline week |
| AS-06 acceptable to send redacted personal data to Claude | AI features depend on it | Owner decision; local-model fallback |
| N5 n8n public API on CE | Only an optimization (reaper precision) | T-P0-03; design does not depend on it |
| A7 MSA/Entra gap for personal Azure DevOps orgs | Could block Entra testing in pilot | Use PAT in pilot |

## 8. Implementation readiness
| Dimension | Status |
|---|---|
| Architecture decisions recorded | ✅ 18 ADRs, all Accepted (one pending library choice) |
| Module specs complete & testable | ✅ 14/14, 111 ACs |
| Data model & constraints | ✅ Designed (not created) |
| Provider contracts & compatibility | ✅ Sketches + capability catalog + matrix |
| Security & reliability design | ✅ Threat model, controls, recovery specs |
| Roadmap & tasks | ✅ 14 phases, ~290 tasks with verify criteria, critical path |
| Validation of technical facts | ✅ Confirmed facts recorded; ⚠ 6 spikes outstanding (P0) |
| Open decisions | ⚠ 12 open (2 company-blocking, 2 P1-blocking) |
| **Verdict** | **Ready to start P0 upon explicit owner approval.** P1 starts after the P0 gate |
