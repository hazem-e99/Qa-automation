# ADR-0016 — Next.js as UI + thin BFF only
- Status: Accepted · Date: 2026-11-09

## Decision
Next.js (App Router) renders the UI and acts as a thin BFF: it proxies authenticated requests to `api`.

**Next.js contains no business rules, no database access, and no provider calls.** It gets all data through the typed API client generated from `@qos/contracts`:
- Initial page loads use Server Components.
- Interactive views use TanStack Query.

This keeps the UI replaceable and all domain logic in one place.

## Alternatives
- **Vite SPA:** no server-side rendering or streaming for heavy dashboards.
- **Remix:** viable, but has a smaller ecosystem and is less aligned with shadcn/ui.
