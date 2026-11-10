# M13 — Team and Permissions

> Status: **Planned** · Phases: P2 (users, roles, project memberships, RBAC enforcement), P11 (custom roles, group mapping prep, access reviews), P13 (SSO groups) · Owner: Security Architect + Backend

## 1. Purpose & responsibilities
This module manages users, role assignments per project and org, service accounts and API tokens, invitations, and the **permission model** that every module enforces.

## 2. Roles (built-in)
| Role | Scope | Intent |
|---|---|---|
| `platform_admin` | Platform | Installs and operates QualityOS: system settings, backups, all orgs (single org in pilot). Not implicitly a project member for data access in enterprise mode (break-glass audited access instead). |
| `org_admin` | Organization | Manages connections, projects, users, org policies |
| `qa_lead` | Project | Owns QA process for project: settings, approvals, cycles, rules, gates |
| `qa_engineer` | Project | Designs and executes tests, drafts defects, requests automation |
| `qc_reviewer` | Project | Reviews and approves tests/defects/evidence per policy; read-mostly |
| `developer` | Project | Reads everything in project, triggers targeted runs (policy), comments, sees defects |
| `project_manager` | Project | Reads, manages cycles' schedule, business approval of requirements (policy), reports |
| `viewer` | Project or Org | Read-only (reports, dashboards, items) |

## 3. Features
| ID | Feature |
|---|---|
| M13-FR-01 | Users: invite (email link, 72 h expiry), activate, deactivate (sessions revoked, tokens revoked, assignments returned), profile (name, locale, timezone, theme) |
| M13-FR-02 | Org role assignment and project membership with one role per user per project (pilot); multiple roles via custom role composition (P11) |
| M13-FR-03 | Permission enforcement: policy guard on every API route declaring required permission + scope resolver (project from path) |
| M13-FR-04 | Service accounts: named, owner, scopes, project restriction, API tokens (prefix `qos_`, shown once, hashed, expiry ≤ 1 year, last used) |
| M13-FR-05 | Personal API tokens (optional, policy-controlled) with subset of user permissions |
| M13-FR-06 | Access review report: who has which role where, last login, dormant accounts (P11) |
| M13-FR-07 | Custom roles (P11): compose from permission catalog; cannot exceed creator's permissions |
| M13-FR-08 | SSO readiness: `user_identities` table, IdP group → role mapping rules (P13) |
| M13-FR-09 | Break-glass access for platform admins in enterprise mode: time-boxed elevation with reason, audited, notified to org admins (P11) |
| M13-FR-10 | Team directory per project with roles, workload (assigned executions) |

## 4. User journeys
J1 (admin invites the team), an access change (QA lead adds a developer as `developer`), offboarding (deactivating a user: tokens revoked, open assignments reassigned).

## 5. UI screens
- `S-ADM-01` Users (org)
- `S-ADM-02` User detail
- `S-PRJ-03` › Members tab
- `S-ADM-03` Service accounts and tokens
- `S-ADM-04` Roles and permissions (read-only matrix in the pilot, editable custom roles in P11)
- `S-ADM-05` Access review

## 6. Domain entities
`users`, `user_identities`, `sessions`, `org_memberships`, `project_memberships`, `roles`, `role_permissions`, `permissions` (catalog seeded from code), `service_accounts`, `api_tokens`, `invitations`, `elevations`.

## 7. API endpoints
| Method | Path |
|---|---|
| GET/POST | `/api/v1/users` · GET/PATCH `/{id}` · POST `/{id}:deactivate` · `:reactivate` |
| POST | `/api/v1/invitations` · POST `/invitations/{token}:accept` |
| GET/PUT/DELETE | `/api/v1/projects/{key}/members/{userId}` |
| GET | `/api/v1/roles` · `/permissions` |
| GET/POST | `/api/v1/service-accounts` · POST `/{id}/tokens` · DELETE `/tokens/{id}` |
| GET/POST | `/api/v1/me/tokens` |
| GET | `/api/v1/me` · `/me/permissions?projectKey=` |
| POST | `/api/v1/auth/login` · `/logout` · `/mfa/*` · `/password/*` (local auth) |

## 8. Business rules
- BR-M13-1: Deny by default. Every route declares exactly one required permission (or `public`). A CI lint test fails if any route lacks a declaration.
- BR-M13-2: Project-scoped permissions are evaluated against `project_memberships` for the path project. An org role grants project permissions only where listed in the matrix (e.g. `org_admin` → project settings, not test execution by default).
- BR-M13-3: Users cannot grant roles above their own, or change their own role.
- BR-M13-4: The last `org_admin` cannot be removed or deactivated.
- BR-M13-5: Deactivation is immediate: sessions are deleted, tokens revoked, and the change is logged. A user's audit events are never deleted.
- BR-M13-6: Each token has explicit scopes, and service tokens cannot use UI session endpoints.

## 9. Permissions matrix (project scope; ● = granted, ◐ = policy-dependent, blank = denied)
| Permission | qa_lead | qa_engineer | qc_reviewer | developer | project_manager | viewer | org_admin |
|---|---|---|---|---|---|---|---|
| project.read | ● | ● | ● | ● | ● | ● | ● |
| project.settings.manage | ● | | | | | | ● |
| project.bindings.manage | | | | | | | ● |
| project.environments.manage | ● | | | | | | ● |
| requirement.create / edit | ● | ● | | | ◐ | | |
| requirement.approve | ● | | ◐ | | ◐ | | |
| requirement_source.manage / document.upload | ● | ● | | | | | ● |
| finding.resolve / finding.waive | ● / ● | ● / | ● / | | | | |
| testcase.create / edit | ● | ● | | ◐ | | | |
| testcase.approve | ● | | ● | | | | |
| ai.tests.generate | ● | ● | | | | | |
| cycle.manage | ● | | | | ◐ | | |
| execution.run | ● | ● | ◐ | | | | |
| execution.reopen | ● | | | | | | |
| run.trigger (non-prod) | ● | ● | | ◐ | | | |
| run.trigger.production | ◐ | | | | | | |
| run.cancel | ● | ● (own) | | ● (own) | | | |
| gate.manage / policy.execution.manage | ● | | | | | | |
| codegen.request | ● | ◐ (automation flag) | | | | | |
| visual.review / visual.baseline.approve | ● / ● | ● / | ● / ◐ | | | | |
| defect.create / edit | ● | ● | ● | ◐ | | | |
| defect.draft.approve / defect.external.sync | ● | | ◐ | | | | |
| classification.override | ● | ● | ● | | | | |
| automation.rule.manage | ● | | | | | | ● |
| automation.rule.run_now | ● | ◐ | | | | | |
| analytics.read | ● | ● | ● | ● | ● | ● | ● |
| report.create / schedule / export | ● | ● (create, export) | ● (export) | | ● | ◐ (export) | ● |
| audit.read (project) | ● | | ● | | | | ● |
| members.manage | ● (≤ own role) | | | | | | ● |

Org-scope permissions:
- `connection.manage`, `connection.secret.rotate`, `connection.retire`: org_admin, platform_admin
- `user.manage`: org_admin
- `org.analytics.read`: org_admin, platform_admin, org viewer
- `cost.read`: org_admin, platform_admin
- `system.settings`, `backup.manage`: platform_admin
- `automation.admin`: platform_admin

## 10. Provider dependencies
`IdentityProvider` port: local (P2), OIDC/Entra (P13).

## 11. Events & workflow integration
Emits `user.invited`, `user.activated`, `user.deactivated`, `membership.changed`, `token.created`, `token.revoked`, `elevation.granted`. Class O: invitation emails sent via n8n (in-app link copy always available as fallback).

## 12. Security requirements
- Passwords: argon2id with tuned parameters and a minimum length of 12, checked against a breached-password list (local k-anonymity list, optional).
- Login and MFA are rate-limited, with lockout and backoff.
- Session cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`, with rotation on privilege change. Idle timeout is 8 h and absolute timeout 7 days (configurable).
- State-changing requests from the browser carry a CSRF token.
- Tokens are hashed with SHA-256 plus a pepper. The prefix is stored for identification.

## 13. Failure scenarios & error handling
Expired invitations can be re-sent. A password reset email failure leaves an admin-generated reset link available (audited). An over-broad token request is rejected with the list of disallowed scopes.

## 14. Edge cases
The same person with different roles across projects, as expected. A user removed from all projects keeps their account but sees only empty states. A service account owned by a deactivated user is flagged for reassignment.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M13-AC-01 | An automated test enumerates every API route and asserts each declares a permission; missing declarations fail CI. |
| M13-AC-02 | A `qa_engineer` in project A gets 404 for any resource in project B. Resource existence is not leaked. |
| M13-AC-03 | Deactivating a user invalidates their active sessions and tokens within 1 s, and the next request returns 401. |
| M13-AC-04 | A `qa_lead` cannot assign `org_admin` or change their own role. |
| M13-AC-05 | A token without scope `automation:fire` receives 403 on `/automation/v1/rules/{id}/fire`. |
| M13-AC-06 | The permission matrix in this document matches the seeded role-permission data (generated-doc test). |

## 16. Implementation tasks
- **P2:**
  - T-P2-01: users, local auth, sessions
  - T-P2-02: MFA (TOTP)
  - T-P2-03: invitations
  - T-P2-40: roles/permissions catalog + seed
  - T-P2-41: policy guard + route declaration lint
  - T-P2-42: project memberships + members UI
  - T-P2-43: service accounts + tokens
  - T-P2-44: users admin UI
  - T-P2-45: `/me/permissions` for UI gating
  - T-P2-46: isolation test harness
- **P11:**
  - T-P11-01: custom roles
  - T-P11-02: access review
  - T-P11-03: break-glass elevation
- **P13:**
  - T-P13-10: OIDC adapter (Entra ID)
  - T-P13-11: group-to-role mapping

## 17. Testing requirements
Exhaustive authorization matrix tests are generated from the matrix: each role × each permission × allow/deny. The isolation test suite covers multi-project setups. Authentication security tests cover brute force, session fixation, and CSRF.

## 18. Dependencies & technical risks
Foundation for all modules.

| Risk | Mitigation |
|---|---|
| Permission checks drift from the documented matrix | Matrix is generated from seed data and verified by test M13-AC-06 |
