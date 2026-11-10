# 21 — Security Architecture

> Status: **Planned** · Owner: Security Architect · Related: [ADR-0010](adr/ADR-0010-sandboxed-execution.md), [ADR-0012](adr/ADR-0012-ai-gateway-bounded-tasks.md), [ADR-0015](adr/ADR-0015-authentication.md), [M13](modules/M13-team-permissions.md), [M14](modules/M14-security-audit-settings.md)

## 1. Security objectives
1. Keep project data confidential, and keep projects isolated from each other.
2. Prevent unauthorized changes to external systems: repositories, trackers, and CI.
3. Contain untrusted code and content: test repositories, generated code, uploaded documents, provider payloads, and AI output.
4. Protect credentials: provider tokens, AI keys, and environment test accounts.
5. Make every important action auditable and every AI decision traceable.
6. Give enterprise SSO and managed secrets a safe path, with no redesign needed.

## 2. Trust boundaries
```mermaid
flowchart LR
  subgraph Internet
    PROV[Provider APIs]:::ext
    AIAPI[AI APIs]:::ext
    WHK[Inbound webhooks]:::ext
  end
  subgraph Host[QualityOS host]
    subgraph Trusted core
      API[api]
      WRK[worker]
      EXC[execution-controller]
      DB[(Postgres)]
      FS[(storage)]
    end
    subgraph Semi-trusted
      N8N[n8n<br/>(service token only)]
      PRS[parser<br/>(no egress)]
    end
    subgraph Untrusted
      SBX[[sandboxes]]
    end
    DSP[socket proxy]
    EGR[egress proxy]
  end
  USERS[Browsers] -->|session cookie, CSRF| API
  WHK -->|verify sig/secret, rate limit| API
  API & WRK --> DB
  WRK --> PROV
  WRK --> AIAPI
  WRK --> PRS
  N8N -->|scoped token| API
  EXC --> DSP --> SBX
  SBX --> EGR --> ENV[Envs under test]
  SBX -->|per-run token| API
  classDef ext fill:#eef,stroke:#88a
```

## 3. Threat model (STRIDE summary)
| # | Threat | Asset / boundary | Mitigation | Verified by |
|---|---|---|---|---|
| T1 | Malicious test code escapes to the host or the DB | Host, DB, secrets | Sandbox: non-root, seccomp, cap-drop, read-only root, no mounts, no socket, isolated network, egress allowlist, per-run tokens ([17 §6](17-test-execution-engine.md)) | Sandbox security suite (M08-AC-05/06) |
| T2 | Test code exfiltrates data to the internet | Project data, tokens | Egress allowlist. The sandbox gets only per-run tokens with narrow scope and short TTL. There are no provider or AI keys in the sandbox | Egress denial tests |
| T3 | Forged webhook triggers actions | Integrity | HMAC or token verification. Azure: Basic auth over HTTPS, then **re-fetch** before acting. Rate limits. Dedupe | M03-AC-02/03 |
| T4 | Prompt injection via documents, issues, or the DOM makes AI produce harmful actions | Integrity, confidentiality | No side-effect tools for untrusted-input tasks. Schema-only outputs, output validators, approval gates, and diff guard plus PR review for codegen | AI security evals |
| T5 | AI data leakage of secrets or PII | Confidentiality | Redaction pipeline, per-project consent, `do_not_send` fields, minimal context | Redaction unit tests + log scan |
| T6 | Unauthorized repository writes, e.g. a push to main | Repo integrity | `qos/` branch prefix enforcement in the adapter and contract tests. Default branch always refused. Write tokens only in the publisher container. PR-only, and QualityOS never merges | M07-AC-02/06 |
| T7 | Cross-project data access (IDOR) | Confidentiality | `ProjectScope` mandatory, policy guard, 404 on foreign resources, RLS defence in depth (P11) | Isolation suite (M13-AC-02) |
| T8 | Credential theft from the DB | Provider tokens | Envelope encryption; master key outside the DB and repo; write-only APIs; rotation; least-privilege tokens | DB dump inspection test |
| T9 | SSRF through configurable URLs (base URLs, environment hosts, reset hooks, webhooks) | Internal network | SafeHttpClient: DNS resolution pinning, denylist (loopback, link-local, metadata 169.254.169.254, internal service names, RFC1918 unless explicitly allowed per environment), scheme allowlist, redirect re-validation | SSRF test suite |
| T10 | Malicious uploads (polyglots, zip bombs, parser exploits) | Parser, host | Magic-byte validation, size and entry caps, parser isolation (no egress, read-only, limits), image re-encoding | Upload security tests |
| T11 | XSS through rendered content (requirements HTML, issue bodies, logs) | Users | Server-side sanitization, CSP (`default-src 'self'`, no inline scripts, trace viewer isolated route), output encoding, Markdown renderer with safe defaults | ZAP baseline + unit tests |
| T12 | CSRF | Users | SameSite=Lax cookie + CSRF token on state-changing requests | Auth tests |
| T13 | Session hijack | Users | HttpOnly/Secure cookies, rotation on login and privilege change, idle and absolute timeouts, optional MFA | Auth tests |
| T14 | Audit tampering | Accountability | Append-only privileges, hash chain, daily digests, export audited | M14-AC-01/02 |
| T15 | Supply chain (npm/pip/images) | Platform | Lockfiles, OSV/pip-audit, Trivy, pinned image digests, Renovate with review, SBOM (CycloneDX) per release | CI gates |
| T16 | n8n compromise | Automation | n8n holds only a scoped service token. Editor bound to localhost. Minimal payloads. Signature verification on dispatches. No DB access | Config review |
| T17 | DoS by runaway runs or AI loops | Availability, cost | Concurrency limits, timeouts, resource limits, AI budgets, step caps, queue limits | Resilience tests |
| T18 | Insider misuse of approvals | Integrity | Separation of duties, content-hash-bound approvals, audit, self-approval only in single-member projects and flagged | M14-AC-03/04 |

## 4. Authorization and project isolation
- **RBAC model and matrix:** [M13 §9](modules/M13-team-permissions.md). Deny by default, and every route declares its permission.
- **Scope resolution:** the project comes from the route (`/projects/{key}/…`) and is resolved to `projectId`. The membership role then maps to permissions. Service tokens use explicit scopes plus an optional project allowlist.
- **Data layer:** repository base classes require a `ProjectScope`, and unscoped queries are allowed only in classes marked `@CrossProject` (code-review gate).
- **Postgres RLS (P11, OD-10):** policies on project-owned tables use `current_setting('qos.project_ids')`. The application sets this per transaction from the resolved scope. System jobs run under the `BYPASSRLS` role, and only in class-E job contexts.
- **Responses:** a request for a foreign project's resource returns 404, not 403, so its existence is not leaked.

## 5. API authentication
| Client | Mechanism |
|---|---|
| Browser (via web BFF) | Server session cookie (opaque ID, hashed in DB), CSRF token |
| Service accounts (n8n, CI) | `Authorization: Bearer qos_<prefix>_<secret>`; hashed with pepper; scopes; expiry ≤ 1 y; IP allowlist optional |
| Sandbox | Per-run JWT signed by API (EdDSA), audience-restricted (`sandbox-upload`, `sandbox-archive`, `ai-proxy`), run-bound claims, TTL ≤ run timeout + margin; validated only on internal listener |
| Webhooks | Provider-specific verification ([13](13-integration-design.md)); no user context |
| Internal service-to-service (worker→parser) | Network isolation + shared secret header; parser not reachable from sandboxes |

**Rate limiting** (token bucket in Postgres-backed or in-memory store per instance; Redis is not required at pilot scale):
- per session: 20 req/s, burst 60
- per service token: 10 req/s
- login and MFA: 5 attempts per minute per account and per IP
- webhooks: 50 req/s per connection
- expensive endpoints (AI generation, run creation, exports): additionally limited per project

Exceeding a limit returns 429 with `Retry-After`.

## 6. Secret management
- **Pilot adapter `db_envelope`:**
  1. A per-secret data key is generated (AES-256-GCM).
  2. The data key is wrapped with the master key (AES-KW), read from `QOS_MASTER_KEY_FILE`, a Docker secret file outside the repo.
  3. The `secrets` table stores the ciphertext, the wrapped data key, and the master key ID.
- **Rotation:**
  - *Secret rotation* (a new value) records the event and destroys the old version after a successful connection test.
  - *Master key rotation* re-wraps all data keys with the new master key. The old key is kept until re-wrap completes.
- **Access:** secrets are decrypted only in memory, in the adapter context. They are zeroized after use where feasible. They are never logged, never returned, and never sent to AI.
- **Enterprise:** the `vault` and `azure_key_vault` adapters keep only references in the DB, and the master-key problem moves to the KMS (OD-05).
- **Developer hygiene:** `.env.example` holds no secrets, Gitleaks runs in pre-commit and CI, and demo-mode secrets are randomly generated per install.

## 7. External mutation controls
Every outward write goes through four layers:
1. **Capability check.** The adapter is able to perform the write.
2. **Approval Policy Engine** ([16 §6](16-test-management-engine.md)). Approval is bound to the exact content hash.
3. **Idempotency key plus marker**, so writes are never duplicated.
4. **Audit event** with the external reference.

Repository writes have additional constraints:
- the `qos/` branch prefix
- never the default or protected branches
- PR-only delivery
- no merge
- the diff guard for generated or maintenance code
- the write token held only by the publisher container

Tracker writes:
- Creating an issue requires approval by default.
- External state transitions are off by default. They are allowed only with the policy setting `allow_external_close`.
- Uploading attachments externally is opt-in.

## 8. Input handling
| Input | Controls |
|---|---|
| File uploads | Extension + magic bytes, size caps (docs 50 MB, evidence 25 MB, video 200 MB resumable), DOCX/XLSX zip entry count ≤ 10k and expanded size ≤ 500 MB, reject encrypted, images re-encoded (strip EXIF), SVG → PNG or reject, store under content hash, never execute |
| Rich text | Server-side HTML sanitization (allowlist tags/attrs), Markdown rendering with no raw HTML, links `rel="noopener noreferrer"` and external-link interstitial for non-allowlisted hosts |
| URLs (connections, environments, hooks) | SafeHttpClient rules (T9); environments may allow RFC1918 hosts explicitly (LAN test servers) — flagged in UI and audit |
| CSV/XLSX import/export | Formula injection neutralization; row/column caps |
| API bodies | Zod validation, size limits (1 MB default; uploads via signed URLs) |
| Provider payloads | Treated as untrusted; sanitized; re-fetch for unsigned |

## 9. Execution environment security
- **Sandbox controls:** see [17 §6](17-test-execution-engine.md).
- **Additional rules:**
  - Fork PR execution is denied by default.
  - Production environments are blocked unless policy and approval allow them.
  - Environment credentials are test accounts only. The documented guidance is to never use real user accounts.
  - Sandboxes never get provider tokens.
- **CI-delegated backend trust shift.** With the CI-delegated backend, isolation is provided by the company's CI runners. QualityOS provides only an upload-only token. This is documented as an explicit trust decision per project.
- **Enterprise hardening.** Use gVisor (`runsc`) as the runtime on Linux servers where available, or Kubernetes with Pod Security "restricted", NetworkPolicies, and the RuntimeDefault seccomp profile.

## 10. Logging, data masking, retention
- **Logging:** structured logs pass through a redaction layer. It masks:
  - known secret values, registered at load time in a redaction set
  - token patterns (GitHub `ghp_`/`github_pat_`, Azure PATs, JWTs, AWS keys, Anthropic/OpenAI key patterns)
  - `Authorization`/`Cookie` headers
  - emails and phone numbers, when the project setting is enabled
- **Never logged:** request bodies for auth endpoints, secret APIs, and uploads.
- **Sandbox logs** are sanitized before storage: environment secret values and token patterns are masked.
- **Retention** follows the policies in [10 §8](10-database-design.md) and [M14](modules/M14-security-audit-settings.md).

## 11. Deployment hardening
| Area | Pilot | Enterprise |
|---|---|---|
| Network exposure | All ports bound to 127.0.0.1; optional tunnel for `/webhooks/*` only | Reverse proxy (TLS 1.2+, HSTS), WAF optional, internal network segmentation (DB not exposed), admin UI via VPN |
| Containers | Non-root users for api/worker/web/parser/controller; read-only FS where possible; resource limits | Same + image signing (cosign) + admission policy |
| Docker access | Only controller via socket proxy | Dedicated runner hosts; controller/agent on separate host from core |
| Secrets | Docker secrets files | KMS/Vault |
| Updates | Renovate PRs; monthly patch window | Patch SLAs by severity |
| Backups | Encrypted (age) to local disk + optional external drive | Offsite encrypted, tested restores |
| Monitoring | Health page + local alerts (in-app/email) | Central logging/metrics, alert routing |

## 12. Pilot data policy (company protection)
- No company source code, requirements, defects, credentials, or data may be used in the personal pilot without written permission (AS-04, BR-13).
- Only the owner's personal GitHub and Azure DevOps organizations, plus synthetic test data.
- The AI provider receives redacted data from personal projects only.
- Before any company use:
  - a security review (this document)
  - an AI data-processing review (OD-08)
  - an n8n license review (OD-01)
  - credentials issued by company IT with least privilege

## 13. Enterprise SSO and managed secrets path
1. Add the OIDC `IdentityProvider` (Entra ID). Local login stays available to break-glass admins only, and is then disabled by policy.
2. Group-to-role mapping is optional. QualityOS RBAC stays authoritative.
3. Move secrets to Azure Key Vault or Vault through a migration command: read each secret from `db_envelope`, write it to the KMS, store the reference, and verify connections.
4. Change Azure DevOps connections to `entra_client_credentials` with certificates.
5. Change GitHub connections, if any, to GitHub Apps. GitLab uses project or group access tokens or bot accounts.
6. Access review and token lifetime policies are enforced (M13-FR-06, M14-FR-14).

## 14. Security testing (summary; details in [24 §8](24-testing-strategy.md))
- SAST (ESLint security rules, Semgrep).
- Dependency and image scanning.
- Secret scanning.
- DAST baseline: OWASP ZAP against a local instance in nightly CI.
- Authorization matrix tests.
- Sandbox escape suite.
- SSRF suite.
- Upload fuzzing.
- AI prompt-injection eval set: documents and DOM containing injected instructions, where the expected outputs ignore them.
