# QualityOS — engineering rules for agents and humans

Source of truth for design: `docs/planning/` (ADRs in `docs/planning/adr/`).
Status: `docs/status/IMPLEMENTATION_STATUS.md`. Closed phase gates: `docs/status/gates/`.

## Architecture invariants

- Modular monolith; modules in `packages/modules/*`; cross-module calls only via each module's `index.ts` or domain events.
- Domain code is framework-free (no `@nestjs`, drizzle, adapters).
- Core code never references provider types (github/gitlab/azure/n8n/anthropic/gemini/playwright). Ask for capabilities via ProviderRegistry.
- Every project-owned query takes a `ProjectScope`.
- All consumers are idempotent (at-least-once). Use expected-state transitions and unique keys.
- Domain events go through the outbox in the same transaction as the state change.
- External mutations require the Approval Policy Engine + idempotency key + audit.
- Untrusted code runs only in sandboxes via execution-controller. Never mount host paths or the Docker socket elsewhere.
- AI only through the AI Gateway with registered, versioned tasks and schema validation.

## Workflow

- Pick the next task ID from `docs/planning/26-task-breakdown.md`; follow its Verify column.
- Tests first for domain logic; contract suites for adapters; E2E in demo mode for journeys.
- Commands: `pnpm build` · `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm test:integration` (needs Docker).
- pnpm is pinned through corepack (`packageManager` in `package.json`). Use `corepack pnpm …` if `pnpm` on PATH is older.
- Tests of the apps run against compiled output, so build first (turbo does this for you).
- Database changes: edit `packages/db/src/schema/*.ts`, then `pnpm db:generate`. Partitioned tables use hand-written migrations.
- Keep PRs small (one task or a tight group). Update `IMPLEMENTATION_STATUS.md` in the same PR.
- Get the owner's go-ahead before starting the next phase.

## Safety

- No company data/credentials. Secrets only in `./secrets` or `infra/compose/.env` (both gitignored) or SecretStore.
- Do not weaken: sandbox settings, egress allowlists, branch-prefix rules, approval policies, redaction.
- Dependency install scripts are denied by default (`allowBuilds` in `pnpm-workspace.yaml`). Ask before allowing a new one.
- Ask before installing anything not listed in `docs/planning/08-technology-decisions.md`.
- The Gemini free tier (ADR-0019) must never receive company or confidential data.

## Local machine notes

- Windows 11 + Docker Desktop (WSL2), Docker data on D:. C: is short on space: keep caches and temp files on D:.
