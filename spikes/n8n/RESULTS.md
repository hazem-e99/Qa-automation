# T-P0-03 — n8n Community Edition behaviour — 2026-11-10

**Run:** native npm install of `n8n@2.46.6` on Windows (Node 24.18, SQLite, data folder on D:), not the Docker image. Steps are the ones in `check.sh`, run by hand against `node_modules/.bin/n8n`.

| Question | Result |
|---|---|
| N6 `/healthz` | 200 as soon as the HTTP server is up, even while DB migrations still run |
| N6 `/healthz/readiness` | 503 during migrations, 200 when ready. **Use this one for the orchestrator health probe** |
| N5 Public REST API on CE | Present: `/api/v1/workflows` without a key returns 401 `{"message":"Unauthorized"}`. Calls with an API key were not tested (a key needs an owner account created in the UI) |
| N4 `import:workflow --separate` with a fixed `id` | Imported 1 workflow |
| N4 Re-import of the same `id` | Overwrites. `list:workflow` shows one row (`qosSpikeHmac0001`), no duplicate |
| Activation from the CLI | `update:workflow --id=… --active=true` still works but prints "Please use: `publish:workflow --id=…`". Both need an **n8n restart** to take effect |
| HMAC check in a Code node (`crypto`, secret from `$env`) | Valid signature → `{"ok":true}`; wrong signature → `{"ok":false}` |
| `export:workflow --backup` | Writes `qosSpikeHmac0001.json` with `"active": true` |

**Conclusions**
- Workflows-as-code works on CE with CLI import/export and stable IDs. ADR-0017 and doc 18 stand.
- Deploy script must use `publish:workflow` and restart n8n after import.
- Settings needed for the HMAC node: `NODE_FUNCTION_ALLOW_BUILTIN=crypto` and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`.
- The spike workflow answers 200 with `ok:false` on a bad signature. Product workflows must answer 401 through a Respond-to-Webhook node.

**Not covered**
- Docker image and Postgres backend: done, see the Docker rerun below.
- Authenticated API calls (`/api/v1/executions`), MFA for the owner account.
- npm skipped the packages' install scripts (`allow-scripts` warnings); n8n started and ran anyway.

## Docker rerun — 2026-11-10 (`n8nio/n8n:2.46.6` + PostgreSQL 17, `bash check.sh`)
Same results as the native run: `/healthz` 200, `/healthz/readiness` 200, API 401 without a key, import twice → one workflow, `publish:workflow` + restart, export round-trip.

**New finding:** with the image defaults both HMAC calls returned `{"message":"Error in workflow"}`. n8n 2.x blocks `$env` in Code nodes by default. After adding `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, valid → `{"ok":true}` and invalid → `{"ok":false}`.

**Design consequence:** that setting exposes every n8n environment variable to every workflow. For the product, prefer keeping the webhook secret in an n8n credential (Webhook node header auth) or verify the signature in QualityOS before the call reaches n8n, and leave env access blocked. To decide in P7 (T-P7 workflow templates).

Still not covered: authenticated API calls, owner MFA.
