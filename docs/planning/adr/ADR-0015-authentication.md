# ADR-0015 — Local accounts first, OIDC-ready
- Status: Accepted · Date: 2026-11-09

## Decision
- **Pilot sign-in:** local accounts.
  - Passwords are hashed with argon2id.
  - TOTP-based MFA is optional.
  - Sessions are server-side. The browser holds only an opaque ID in an httpOnly, `SameSite=Lax`, `Secure` cookie.
- **Identity provider:** an `IdentityProvider` abstraction exists from day one. The P13 OIDC adapter adds Entra ID first. It maps each `(iss, sub)` pair to a row in `user_identities`, and it can optionally map identity-provider groups to roles.
- **Service accounts** (n8n, CI) use API tokens. Each token is:
  - scoped to specific permissions
  - hashed at rest
  - identifiable by its prefix
  - set to expire
  - limited to specific projects
- **Authorization** always comes from QualityOS RBAC ([M13](../modules/M13-team-permissions.md)).

## Consequences
- (+) Sign-in works offline, and there is a clean upgrade path to SSO.
- (−) The pilot has to store and manage passwords. Password login can be disabled once OIDC is enforced.
