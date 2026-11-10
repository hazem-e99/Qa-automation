# QualityOS

Provider-agnostic, AI-assisted quality engineering platform. Design: [docs/planning](docs/planning/README.md). Build status: [docs/status/IMPLEMENTATION_STATUS.md](docs/status/IMPLEMENTATION_STATUS.md).

**State:** Phase 1 (foundation) is built and waiting for its gate review. There is no product feature yet: the repository holds the platform foundations and an empty application shell.

## Requirements

- Node 24 LTS, corepack (ships with Node), Docker Desktop (for the database and integration tests)

## Getting started

```bash
corepack pnpm install
```

```bash
corepack pnpm build
```

Create local secrets once (writes `infra/compose/.env`, never overwrites it), then check the machine:

```bash
corepack pnpm qos init
```

```bash
corepack pnpm qos doctor
```

Start the whole stack in Docker (PostgreSQL, migrations, api, worker, web):

```bash
corepack pnpm stack:up
```

Then open http://127.0.0.1:3000. Stop it with `corepack pnpm stack:down` (data volumes are kept).

| Service  | Address           | Notes                                                                       |
| -------- | ----------------- | --------------------------------------------------------------------------- |
| web      | `127.0.0.1:3000`  | Shell in English (`/en`) and Arabic (`/ar`)                                 |
| api      | `127.0.0.1:3001`  | `/healthz`, `/readyz`, `/api/v1/operations/{id}`, `/files/*` (signed links) |
| postgres | `127.0.0.1:55432` | 5432 is left free for a local PostgreSQL                                    |

The API has no authentication yet (Phase 2). Every port binds to loopback only; do not expose them.

To run the apps on the host instead, start only the database with `corepack pnpm dev:db`, set
`DATABASE_URL`, run `corepack pnpm db:migrate`, then `node apps/api/dist/main.js`.

## Checks

| Command                          | What it runs                                                              |
| -------------------------------- | ------------------------------------------------------------------------- |
| `corepack pnpm lint`             | ESLint and the architecture rules (dependency-cruiser)                    |
| `corepack pnpm typecheck`        | TypeScript, all packages                                                  |
| `corepack pnpm test`             | Unit tests                                                                |
| `corepack pnpm e2e`              | Browser tests of the web shell (Playwright; run `pnpm build` first)       |
| `corepack pnpm test:integration` | Integration tests against a throwaway PostgreSQL container (needs Docker) |

## Layout

```
apps/        api, worker, execution-controller, web
packages/    contracts, kernel-domain, ports, observability, db, kernel-infra, config
packages/modules/   domain modules (jobs, platform, probe)
tools/cli/          `qos` command (init, doctor)
infra/compose/      local Docker Compose files
docs/planning/      approved design package and ADRs
docs/status/        implementation status and phase gates
spikes/             Phase 0 throwaway experiments (not part of the product)
```
