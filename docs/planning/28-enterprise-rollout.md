# 28 — Enterprise Rollout

> Status: **Planned** (phase P13 onward) · Owner: Product Manager + Platform Engineer + Security Architect

## 1. What changes from pilot to company (and what does not)
| Area | Pilot | Company | Architectural impact |
|---|---|---|---|
| Source control | GitHub (PAT) | **GitLab** (project/group access tokens or bot) | New adapter (contract-tested); **no core change** |
| Requirements | Azure Boards (PAT) + docs | Azure Boards (**Entra** service principal) + docs | Auth strategy switch in adapter |
| Issues | Azure Boards | Azure Boards | Same adapter; company process template mappings |
| CI | Local execution | **GitLab CI** (trigger and/or results ingest) + optional local runners | CI adapter + CI-delegated backend |
| Identity | Local accounts | **Entra ID OIDC** | IdentityProvider adapter |
| Secrets | DB envelope + master key file | **Azure Key Vault / Vault** | SecretStore adapter + migration command |
| Storage | localfs | **S3-compatible** / Azure Blob | Storage adapter + copy command |
| Orchestration | n8n CE local | n8n (license per OD-01) on server, or another adapter | Port unchanged |
| Execution | Docker Desktop on laptop | Dedicated Linux runner host(s), gVisor optional; or CI runners | Backend config; runner agent mode |
| Users | 1 | Multiple QA/QC teams | Same RBAC; templates; access reviews |
| Hosting | Laptop | Internal server(s), TLS, backups, monitoring | Same images; prod compose overlay |
| Data | Personal/synthetic | Confidential company data | Security/legal reviews (OD-08), retention, DPA review |

**Unchanged:** domain model, modules, APIs, events, workflows, approval engine, KPIs, UI.

## 2. Preconditions for company adoption (go/no-go checklist)
- [ ] The pilot report recommends go, with the success criteria met ([27 §6](27-pilot-validation-plan.md)).
- [ ] **Legal:** company use of the n8n Sustainable Use License confirmed, or an alternative chosen (OD-01).
- [ ] **Security review** of [21](21-security-architecture.md) completed by company security. Findings resolved.
- [ ] **AI data processing approval** (OD-08): which provider, under which enterprise terms, data residency, and the allowed data classes. Alternatively, a local model for confidential projects.
- [ ] Company IT has provisioned: server(s), DNS, TLS certificates, Entra app registration (OIDC plus Azure DevOps service principal), Key Vault, object storage, backup target, monitoring integration.
- [ ] GitLab adapter contract suites pass in recorded mode, and in live mode against a company sandbox group (T-P13-17).
- [ ] A migration rehearsal (§4) succeeded on staging.
- [ ] A DR test (restore to a fresh host) succeeded.
- [ ] Training material and an onboarding playbook are ready (T-P13-12/16).
- [ ] Sponsors agreed success KPIs for the company pilot.

## 3. Enterprise deployment architecture
```mermaid
flowchart TB
  subgraph DMZ/Ingress
    RP[Reverse proxy / LB<br/>TLS, WAF optional]
    WH[Webhook ingress<br/>/webhooks/* only]
  end
  subgraph App zone
    WEB[web ×2]
    API[api ×2]
    WRK[worker ×2]
    N8N[n8n]
  end
  subgraph Execution zone (separate host/VLAN)
    EC[execution-controller / runner agents]
    DSP[socket proxy]
    SBX[[sandboxes (gVisor optional)]]
    EGR[egress proxy]
  end
  subgraph Data zone
    PG[(PostgreSQL 17 + pgvector<br/>WAL archiving / PITR)]
    OBJ[(S3-compatible storage)]
    KV[Key Vault / Vault]
  end
  IDP[Entra ID]:::ext
  GL[GitLab]:::ext
  ADO[Azure DevOps]:::ext
  AIP[AI provider (approved)]:::ext
  Users --> RP --> WEB --> API
  GL & ADO --> WH --> API
  API & WRK --> PG
  API & WRK --> OBJ
  API & WRK --> KV
  API --> IDP
  WRK --> GL & ADO & AIP
  N8N --> API
  EC --> PG
  EC --> DSP --> SBX --> EGR --> Envs[Company test environments]
  SBX --> API
  classDef ext fill:#eef,stroke:#88a
```
- **Scaling:** stateless api, web, and worker processes run as two or more instances. The controller scales out as runner agents, with leases. n8n runs single-main, which is acceptable at this volume; queue mode exists in Community Edition if needed (N3).
- **Network:** the execution zone reaches the environments under test and the internal API listener only. It cannot reach the data zone directly.
- **Kubernetes** is not required. If IT prefers it, a Helm chart and a Jobs-based execution backend are offered as options (OD-12).

## 4. Local-to-enterprise migration plan
Use this plan if the owner wants to carry pilot configuration, templates, or history into the company instance. **No personal pilot data should be imported into a company instance without approval.** By default, only **configuration templates** are migrated.

1. **Export configuration** with `qos export --config-only`. It exports project templates, approval policies, KPI settings, automation rule templates, and conventions files. No secrets and no personal data are included.
2. **Provision the company instance** with the same image versions. Run migrations and verify `/readyz`.
3. **Configure identity:** OIDC, the break-glass admin, and group-to-role mapping.
4. **Configure secrets:** the Key Vault adapter, then create connections with company-issued credentials (GitLab tokens, the Entra service principal for Azure DevOps).
5. **Import configuration:** `qos import --config-only`, then review it.
6. **Create the first company project** with the wizard, using GitLab, Azure Boards, and GitLab CI, then run the health check.
7. **Optional history migration** (if approved): `qos export --project X` and `qos import`. This preserves IDs, ExternalRefs (with retired connections), and artifacts. For artifacts, use `qos storage:copy --from localfs --to s3`.
8. **Run the verification suite:** the E2E smoke in demo mode on staging, contract live runs, and a backup/restore drill.
9. **Cut over:** enable users and announce.

**Rollback:** the company instance is new. Rollback means disabling access. The pilot instance stays untouched.

## 5. Rollout phases (company)
| Stage | Scope | Duration | Exit criteria |
|---|---|---|---|
| R0 Setup | Infra, reviews, adapters (P13) | 4–6 weeks | §2 checklist |
| R1 Company pilot | 1 project, 1 QA team (3–5 people), manual + AI test design + execution | 8 weeks | Agreed KPIs met; team NPS-style feedback ≥ neutral-positive; no critical incidents |
| R2 Expansion | 3–5 projects, 2–3 teams; automation on 1–2 projects | 3 months | Coverage/frequency targets per project; support load manageable |
| R3 General availability | Opt-in for all projects; standard templates; training program | ongoing | Adoption metrics; quarterly reviews |

## 6. Capacity sizing (initial guidance; validate with T-P13-18)
| Component | Small (≤10 projects, ≤20 users) | Medium (≤50 projects, ≤100 users) |
|---|---|---|
| App host | 4 vCPU / 16 GB | 8 vCPU / 32 GB (2 nodes) |
| Postgres | 2 vCPU / 8 GB / 200 GB SSD | 4 vCPU / 16 GB / 500 GB SSD + replica |
| Runner capacity | 4 parallel shards (8 vCPU / 16 GB) | 12–16 shards across 2–3 hosts |
| Object storage | 500 GB | 2 TB (retention-managed) |

## 7. Organizational readiness
- **Roles:**
  - a platform owner, in IT/QA engineering
  - a QA process owner, to own templates and policies
  - a security contact
- **Support model:**
  - an internal channel
  - runbooks ([22 §11](22-observability-and-reliability.md))
  - an issue tracker for QualityOS itself
- **Change management:**
  - training sessions per role (QA engineer, lead, developer, PM)
  - office hours for the first 4 weeks
  - adoption metrics on a dashboard
- **Governance:** quarterly access reviews, a prompt and model change review board (lightweight), and a KPI definition review.
