# QualityOS

Provider-agnostic, AI-assisted quality engineering platform. Design: [docs/planning](docs/planning/README.md). Build status: [docs/status/IMPLEMENTATION_STATUS.md](docs/status/IMPLEMENTATION_STATUS.md).

**State:** Phase 1 (foundation) in progress. There is no product feature yet: the repository holds the monorepo, the database and job/outbox foundations, and three backend processes with health endpoints.

## Requirements

- Node 24 LTS, corepack (ships with Node), Docker Desktop (for the database and integration tests)

## Getting started

```bash
corepack pnpm install
```

```bash
corepack pnpm build
```

Start a local database (copy `infra/compose/.env.example` to `infra/compose/.env` first and set a password):

```bash
corepack pnpm dev:db
```

Apply migrations and run the processes on the host (set `DATABASE_URL` to match your `.env`):

```bash
corepack pnpm db:migrate
```

```bash
node apps/api/dist/main.js
```

| Process              | Default address  | Endpoints                                                                                  |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| api                  | `127.0.0.1:3001` | `/healthz`, `/readyz`, `/api/v1/platform/probes` (diagnostic, not available in production) |
| worker               | `127.0.0.1:3002` | `/healthz`, `/readyz`                                                                      |
| execution-controller | `127.0.0.1:3003` | `/healthz`, `/readyz`                                                                      |

The API has no authentication yet (Phase 2). It binds to loopback only; do not expose it.

## Checks

| Command                          | What it runs                                                              |
| -------------------------------- | ------------------------------------------------------------------------- |
| `corepack pnpm lint`             | ESLint and the architecture rules (dependency-cruiser)                    |
| `corepack pnpm typecheck`        | TypeScript, all packages                                                  |
| `corepack pnpm test`             | Unit tests                                                                |
| `corepack pnpm test:integration` | Integration tests against a throwaway PostgreSQL container (needs Docker) |

## Layout

```
apps/        api, worker, execution-controller (composition roots)
packages/    contracts, kernel-domain, ports, observability, db, kernel-infra, config
packages/modules/   domain modules (jobs, probe)
infra/compose/      local Docker Compose files
docs/planning/      approved design package and ADRs
docs/status/        implementation status and phase gates
spikes/             Phase 0 throwaway experiments (not part of the product)
```
