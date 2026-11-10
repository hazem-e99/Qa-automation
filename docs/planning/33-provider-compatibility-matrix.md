# 33 — Provider Compatibility Matrix

> Status: **Planned**. The matrix shows *designed* support. In CI it is regenerated from contract-suite results ([12 §5](12-provider-contracts.md)). Legend: ● supported (planned) · ◐ supported with limitations or fallback · ○ not supported (fallback applies) · — not applicable. Phase = when the adapter is built.

## 1. Source control
| Capability | GitHub (P2) | GitLab (P13) | Azure Repos (P13) | Local Git (P2, demo) | Mock |
|---|---|---|---|---|---|
| repo.read | ● | ● | ● | ● | ● |
| repo.commits.list | ● | ● | ● | ● | ● |
| repo.diff.read | ● | ● | ● | ● | ● |
| repo.branch.create | ● | ● | ● | ◐ (local bare remote) | ● |
| repo.commit.push | ● | ● | ● | ◐ | ● |
| repo.pr.create / read / comment | ● | ● (MR) | ● | ○ → patch download | ● |
| repo.branch.protection.read | ● | ● | ◐ (branch policies) | ○ | ● |
| repo.checks.report | ● (commit status/checks) | ● (commit status) | ◐ (PR status) | ○ | ● |
| repo.clone_token.issue | ◐ (App token; PAT → proxied archive) | ◐ (deploy token / proxied archive) | ◐ (proxied archive) | ◐ (proxied archive) | ● |
| repo.webhooks.manage | ● | ● | ● (service hooks) | ○ (poll only) | ● |
| Webhook verification | HMAC-SHA256 | Shared token | Basic + re-fetch | — | configurable |

## 2. Requirements sources
| Capability | Azure Boards (P3) | Document set DOCX/PDF (P3) | Spreadsheet XLSX/CSV (P3) | Manual (P3) | GitHub/GitLab issues as requirements (future) |
|---|---|---|---|---|---|
| requirements.list_changed | ● (WIQL + ChangedDate) | ● (uploads) | ● (uploads) | ● | ◐ |
| requirements.get | ● | ● | ● | ● | ◐ |
| requirements.revisions | ● (rev) | ● (series version) | ● (series version) | ● (edit history) | ○ |
| requirements.links (hierarchy) | ● | ◐ (section tree) | ◐ (parent column) | ● | ◐ |
| requirements.attachments.read | ● | — | — | ● | ◐ |
| Acceptance criteria extraction | ● (AC field) + AI assist | ◐ (structure + AI, confidence) | ● (mapped column) | ● | ◐ |
| Arabic support | ● | ◐ (OCR quality-dependent) | ● | ● | ● |

## 3. Issue tracking
| Capability | Internal (P4) | Azure Boards (P8) | GitHub Issues (P8) | GitLab Issues (P13) |
|---|---|---|---|---|
| issues.metadata.read | ● | ● (types/states/fields per process) | ◐ (labels only) | ◐ (labels, scoped labels) |
| issues.create / get / update | ● | ● | ● | ● |
| issues.list_changed | ● | ● | ● | ● |
| issues.comment | ● | ● | ● | ● |
| issues.attachments.create | ● | ● | ○ (no API for issue attachments; links used) | ● (uploads API) |
| issues.transition | ● | ● | ◐ (open/closed) | ◐ (open/closed + labels) |
| issues.search_by_marker | ● | ● (tag + WIQL) | ● (search API) | ● (search API) |
| Severity/priority native fields | ● | ● | ○ → labels | ○ → scoped labels |

## 4. CI/CD
| Capability | Local (P6) | GitHub Actions (P13) | GitLab CI (P13) | Azure Pipelines (P13) |
|---|---|---|---|---|
| ci.pipeline.trigger | — (direct execution) | ● (workflow_dispatch) | ● (trigger API) | ● (run pipeline) |
| ci.pipeline.status | — | ● | ● | ● |
| ci.artifacts.read | — | ● | ● | ● |
| ci.events.deployments | ◐ (manual "deployment completed" via API) | ● (deployment_status) | ● (deployments) | ● (environments/releases) |
| ci.status.report | — | ● | ● | ◐ |
| Results ingestion via Automation API | ● | ● | ● | ● |

## 5. AI
| Capability | Claude (P5) | OpenAI (P13+) | Gemini (P13+) | OpenAI-compatible local (P11) |
|---|---|---|---|---|
| ai.generate.structured | ● | ● | ● | ◐ (model-dependent) |
| ai.generate.text | ● | ● | ● | ● |
| ai.embed | ○ → configure separate embedding provider | ● | ● | ● |
| ai.vision | ● | ● | ● | ◐ |
| ai.tools (sandbox codegen) | ● | ● | ● | ◐ |
| ai.prompt_cache | ● | ◐ | ◐ | ○ |
> Verify each provider's capabilities against official docs at the phase in which its adapter is built (T-P0-06 for Claude).

## 6. Storage, orchestration, engine, backend, secrets, identity
| Family | Adapter (phase) | Notes |
|---|---|---|
| Storage | localfs (P1) ● · S3-compatible (P13) ● · Azure Blob (future) ○ | MinIO CE rejected |
| Orchestration | n8n (P7) ● · Null/essential-only (P7) ● · other engines (future) | n8n CE limits: [36 N3](36-technical-validation.md) |
| Test engine | Playwright (P6) ● (UI, API, visual, traces, codegen) · others future | Engine/back-end pairing via capability |
| Execution backend | Local Docker (P6) ● · CI-delegated (P13) ● · remote runner pool (P13+) ◐ | [ADR-0018](adr/ADR-0018-test-engine-vs-execution-backend.md) |
| Secrets | DB envelope (P2) ● · Vault / Azure Key Vault (P13) ● | OD-05 |
| Identity | Local (P2) ● · OIDC Entra ID (P13) ● · other OIDC ● | OD-04 |

## 7. Mixed-provider scenarios (must work simultaneously)
| Scenario | Repo | Requirements | Issues | CI | Validated by |
|---|---|---|---|---|---|
| Pilot | GitHub | Azure Boards + PDF | Azure Boards | Local | P12 pilot |
| Brief example | GitHub | PDF | Azure Boards | Local | E2E mixed-provider test (mocks) |
| Company target | GitLab | Azure Boards | Azure Boards | GitLab CI | P13 company pilot |
| Offline/demo | Local Git | Manual + XLSX | Internal | Local | Demo-mode E2E |
| Minimal | none | Manual | Internal | none | Manual-QA-only E2E |
