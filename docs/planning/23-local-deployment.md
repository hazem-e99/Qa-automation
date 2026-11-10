# 23 — Local Deployment

> Status: **Planned**. Nothing has been installed or started. · Owner: DevOps / Platform Engineer · Related: [18 §10](18-n8n-orchestration.md), [28](28-enterprise-rollout.md)

## 1. Goals
- **Reproducible start:** one command brings up a full local environment on Windows 11 (Docker Desktop with WSL2), macOS, or Linux.
- **Demo mode:** works with **no external credentials**.
- **Same container images and config schema as the future server deployment.** Only the env and secrets differ.

## 2. Compose services and profiles
| Service | Image (planned) | Profile | Ports (host) | Volumes | Notes |
|---|---|---|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | core | 127.0.0.1:5432 (dev only) | `pgdata` | DBs: `qualityos`, `n8n` (init script creates roles/DBs) |
| `migrate` | app image (`qos-backend`) cmd `migrate` | core | — | — | Runs once; others depend on success |
| `api` | `qos-backend` cmd `api` | core | 127.0.0.1:3000 (API), 127.0.0.1:3001 (webhooks listener), internal 3002 (sandbox listener) | `artifacts` | |
| `worker` | `qos-backend` cmd `worker` | core | — | `artifacts`, local git roots (ro, optional) | |
| `web` | `qos-web` | core | 127.0.0.1:8080 | — | UI entry point |
| `parser` | `qos-parser` | core | — (internal) | — | `network: qos-internal` only, no egress (internal network) |
| `execution-controller` | `qos-backend` cmd `controller` | exec | — | — | Talks to `docker-socket-proxy` |
| `docker-socket-proxy` | e.g. `tecnativa/docker-socket-proxy` (pinned) | exec | — | `/var/run/docker.sock:ro` | Only service mounting the socket; env allowlist (CONTAINERS=1, IMAGES=1, POST=1, EXEC=0, BUILD=0, VOLUMES=0, NETWORKS=0…) |
| `egress-proxy` | Squid (pinned) | exec | — | `egress_acl` (ro; the controller writes it) | On `qos-sandbox` + `qos-egress` networks |
| `registry-mirror` | Verdaccio (pinned) | exec (optional) | — | `npm_cache` | npm cache for sandboxes |
| `n8n` | `docker.n8n.io/n8nio/n8n:<pinned>` | n8n | 127.0.0.1:5678 | `n8n_data`, `infra/n8n/workflows:ro` | [18 §10](18-n8n-orchestration.md) |
| `mailpit` | Mailpit (pinned) | dev | 127.0.0.1:8025 | — | Local email catcher |
| `jaeger`, `prometheus`, `grafana`, `loki` | pinned | observability | 127.0.0.1:* | — | Optional |
| `tunnel` | cloudflared (pinned) | tunnel | — | config | Exposes only `api:3001` path `/webhooks/*` |

**Networks:**
| Network | Members | Outbound internet |
|---|---|---|
| `qos-internal` | api, worker, web, parser, controller, n8n, postgres | Default. The parser is attached **only** to an `internal: true` network |
| `qos-sandbox` (`internal: true`) | sandboxes, egress-proxy, api's sandbox listener (via a dedicated alias `api-internal`) | None |
| `qos-egress` | egress-proxy | Yes |

> The egress-proxy ACL is written by the execution-controller into a small shared volume `egress_acl` (controller has rw, proxy has ro). Squid then gets a reconfigure signal. Spike T-P0-04 validates this mechanism on Windows/WSL2. The alternative is an authenticating proxy with an external ACL helper that calls the API.

**Profiles:**
| Profile | Services | Purpose |
|---|---|---|
| `core` | postgres, migrate, api, worker, web, parser | Requirements and manual testing work |
| `exec` | adds controller, socket proxy, egress proxy, optional mirror | Automated runs |
| `n8n` | adds n8n | Orchestration |
| `dev` | adds mailpit | Local email |
| `observability` | adds the tracing and metrics stack | Optional |
| `tunnel` | adds the tunnel | Optional webhooks |

Example commands (planned, not executed):
```bash
docker compose --profile core --profile exec --profile n8n up -d
```
```bash
pnpm qos demo:up        # wrapper: core+exec+n8n, demo seed, opens http://localhost:8080
```

## 3. Environment variables (typed config, validated at boot)
| Variable | Example | Notes |
|---|---|---|
| `QOS_ENV` | `local` / `test` / `production` | |
| `QOS_BASE_URL` | `http://localhost:8080` | |
| `QOS_API_URL` | `http://localhost:3000` | |
| `QOS_DATABASE_URL_FILE` | `/run/secrets/db_url` | Prefer `*_FILE` for secrets |
| `QOS_MASTER_KEY_FILE` | `/run/secrets/master_key` | 32-byte random, base64 |
| `QOS_SESSION_SECRET_FILE` | `/run/secrets/session_secret` | |
| `QOS_STORAGE_BACKEND` | `localfs` | `s3` later |
| `QOS_STORAGE_LOCALFS_ROOT` | `/data/artifacts` | |
| `QOS_DEMO_MODE` | `true/false` | Seeds demo project; enables mock connections |
| `QOS_TIMEZONE` | `Africa/Cairo` | Org default |
| `QOS_LOCAL_GIT_ROOTS` | `/repos` | Read-only mounts for Local Git adapter |
| `QOS_WEBHOOK_PUBLIC_BASE_URL` | `https://hooks.example.com` | If tunnel used |
| `QOS_EXEC_MAX_PARALLEL` | `2` | Host-level cap (≤ sum of project caps) |
| `QOS_EXEC_MIN_FREE_DISK_GB` | `10` | Controller guard |
| `QOS_OTEL_EXPORTER_OTLP_ENDPOINT` | empty | Optional |
| `QOS_N8N_BASE_URL` | `http://n8n:5678` | Internal |

`.env.example` documents every variable without values. `pnpm qos init` generates `./secrets/*` (random master key, session secret, DB passwords, n8n encryption key) with restrictive file permissions, and `.gitignore` excludes them.

## 4. Data and volumes
| Volume | Content | Backup |
|---|---|---|
| `pgdata` | Postgres (qualityos + n8n DBs) | `pg_dump` nightly |
| `artifacts` | localfs object storage | tar/rsync nightly (incremental) |
| `n8n_data` | n8n config (encryption key is in secrets, not here) | n8n export + volume tar |
| `npm_cache` | registry mirror | not backed up |
| `egress_acl` | transient ACLs | not backed up |

## 5. Resource budget (pilot, AS-02)
| Component | Memory (approx.) | CPU |
|---|---|---|
| postgres | 512 MB–1 GB | 0.5–1 |
| api + worker + controller | 3 × ~300 MB | 0.5 each |
| web | ~300 MB | 0.25 |
| parser | 500 MB–1.5 GB (OCR peaks) | 1 (bursts) |
| n8n | ~400 MB | 0.25 |
| proxies/mirror | ~200 MB | 0.1 |
| **Subtotal (idle/light)** | **~3–4 GB** | ~3 |
| Each sandbox shard | 3 GB (policy default) | 2 |
| **With 2 concurrent shards** | **~10 GB** | ~7 |

On a 16 GB machine the defaults are `QOS_EXEC_MAX_PARALLEL=2` and shard memory 3 GB, and the observability profile stays off. With 32 GB, 4 parallel shards are allowed. The Docker Desktop WSL2 memory limit must be raised in `.wslconfig`. That step is documented, and it is the owner's action.

## 6. Development vs test vs demo configurations
| Mode | DB | Providers | AI | n8n | Purpose |
|---|---|---|---|---|---|
| `dev` | local Postgres | real or mock | real (budgeted) or mock | optional | Building features |
| `test` (CI) | Testcontainers Postgres per suite | **mock + recorded fixtures** | **mock** (deterministic fixtures) | containerized for template tests (nightly) | Automated tests; no credentials needed |
| `demo` | local Postgres with demo seed | mock connections (labelled Demo) | mock by default; optional real if key configured | optional; Null orchestrator otherwise | Showcase without credentials |
| `pilot` | local Postgres | GitHub + Azure DevOps + Claude | real | on | Personal pilot |

Demo seed contents:
- Project "ShopDemo":
  - 25 requirements from mock Azure Boards, a 6-page English PDF, and a 4-page Arabic PDF
  - 60 test cases, 30 of them automated against `fixtures/demo-app`
  - 3 historical runs, including failures, a flaky test, and a visual diff
  - 5 defects, including one synced to the mock tracker
- Project "ApiDemo", for multi-project isolation demos.
- The demo app (`fixtures/demo-app`) is a small web app with toggleable seeded bugs. It runs as a Compose service in the `exec` profile so sandboxes can reach it through the allowlist.

## 7. Secrets and the master key
- `secrets/master_key` is the root of all encrypted credentials. **Back it up separately**, for example in a password manager. Losing it means re-entering all integration credentials, but domain data is unaffected.
- Master key rotation: `pnpm qos secrets:rotate-master` re-wraps all data keys ([21 §6](21-security-architecture.md)).

## 8. Backup scripts (planned)
- `infra/scripts/backup.sh` / `backup.ps1`:
  - `pg_dump -Fc` for both DBs, plus a tar of `artifacts` (incremental by mtime), plus an n8n export.
  - Everything is encrypted with `age -r <owner public key>` into `backups/YYYY-MM-DD/`.
  - Retention: 7 daily, 4 weekly, 3 monthly.
  - It can be run by Windows Task Scheduler or cron, or by the class-E `backup.run` job when the backup target is a mounted path.
- `infra/scripts/restore.sh`:
  1. Stop app services.
  2. Restore the DBs into fresh volumes.
  3. Restore artifacts.
  4. Import n8n workflows.
  5. Run migrations (no-op if versions match).
  6. Start, then run `verify-integrity`.
- The weekly `restore.verify` job runs automatically ([22 §10](22-observability-and-reliability.md)).

## 9. Local HTTPS and tunnelling
- No HTTPS is needed for `localhost` UI use.
- Webhooks from GitHub can use a tunnel (HTTPS). Azure DevOps service hooks with Basic auth **require HTTPS**, so a tunnel is required for them. Otherwise rely on polling, which is the default.
- The tunnel config exposes only `api:3001`, path-prefixed `/webhooks/`. The setup guide includes a verification step (`curl https://<tunnel>/api/...` must return 404).

## 10. Health checks and first-run verification
- `pnpm qos doctor` (planned CLI) checks:
  - Docker version and memory available to Docker
  - WSL2 memory limit
  - ports free
  - secrets present
  - DB reachable
  - migrations applied
  - storage writable
  - parser responding
  - socket proxy restricted (attempts `exec` and expects a denial)
  - egress proxy denies `example.com` from a test sandbox
  - n8n reachable, with templates imported and signature verification working (a test dispatch)
- The output is a checklist with remediation hints.

## 11. Mock providers
`adapters-mock` provides mock connections for every family (GitHub-like, GitLab-like, Azure-like, AI, orchestrator, CI). Each supports deterministic seed data, capability toggles, fault injection, and webhook emission ([11 §8](11-provider-architecture.md)).

## 12. Path to company server
The same images run on a Linux host with Compose, a reverse proxy for TLS, external secret management, and optionally separate runner hosts. See the migration plan in [28 §4](28-enterprise-rollout.md).
