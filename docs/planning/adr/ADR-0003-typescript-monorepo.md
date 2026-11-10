# ADR-0003 — TypeScript monorepo (pnpm + Turborepo)
- Status: Accepted · Date: 2026-11-09 · Deciders: Staff Full-Stack Engineer

## Context
The frontend, backend, contracts, and Playwright tests all fit naturally in TypeScript. Sharing types for API contracts, event schemas, and AI output schemas keeps them from drifting apart.

## Decision
Use a pnpm workspace with Turborepo task caching. The layout is in [07 §6](../07-system-architecture.md).

Shared packages:
- `@qos/contracts`: Zod schemas for the API, events, and AI outputs
- `@qos/domain`
- `@qos/ports`
- `@qos/adapters-*`
- `@qos/ui`

The Python parser lives in `services/parser` with its own `pyproject.toml`. It communicates only through HTTP/JSON contracts defined in `@qos/contracts` and exported as JSON Schema.

## Alternatives considered
- **Nx**: richer feature set, but heavier.
- **Polyrepo**: contracts drift apart, and the overhead is too high for a single developer.
- **npm or yarn workspaces**: pnpm is stricter about phantom dependencies.

## Consequences
- (+) One `pnpm install`, and changes that span packages land atomically.
- (−) The Python service needs its own tooling (uv), documented in [23](../23-local-deployment.md).

## Revisit when
Builds take more than about 10 minutes even with caching.
