#!/usr/bin/env bash
# T-P0-03: answer N4–N6 questions for the pinned n8n version. Requires Docker. Run from spikes/n8n.
set -uo pipefail
export MSYS_NO_PATHCONV=1
mkdir -p out
log() { echo "$*" | tee -a out/results.txt; }
: > out/results.txt
docker compose up -d --wait db
docker compose up -d n8n
for i in $(seq 1 60); do curl -sf http://127.0.0.1:5679/healthz/readiness >/dev/null && break; sleep 2; done

log "N6 /healthz: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5679/healthz)"
log "N6 /healthz/readiness: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5679/healthz/readiness)"
log "N5 /api/v1/workflows without key (expect 401 if API exists, 404 if absent): $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5679/api/v1/workflows)"

log "N4 import (stable id):"
docker compose exec -T n8n n8n import:workflow --separate --input=/workflows 2>&1 | tee -a out/results.txt
log "N4 re-import same id (expect overwrite, no duplicate):"
docker compose exec -T n8n n8n import:workflow --separate --input=/workflows 2>&1 | tee -a out/results.txt
log "N4 list:"
docker compose exec -T n8n n8n list:workflow 2>&1 | tee -a out/results.txt
log "Activation via CLI (publish:workflow, needs restart):"
docker compose exec -T n8n n8n publish:workflow --id=qosSpikeHmac0001 2>&1 | tee -a out/results.txt
docker compose restart n8n >/dev/null; for i in $(seq 1 60); do curl -sf http://127.0.0.1:5679/healthz/readiness >/dev/null && break; sleep 2; done

body='{"eventId":"e1","type":"run.finalized"}'
ts=$(date +%s)
sig=$(printf '%s' "$ts.$body" | openssl dgst -sha256 -hmac spike-secret -hex | awk '{print $NF}')
log "HMAC valid   -> $(curl -s -X POST -H 'content-type: application/json' -H "x-qos-timestamp: $ts" -H "x-qos-signature: $sig" -d "$body" http://127.0.0.1:5679/webhook/qos-spike-hmac)"
log "HMAC invalid -> $(curl -s -X POST -H 'content-type: application/json' -H "x-qos-timestamp: $ts" -H 'x-qos-signature: deadbeef' -d "$body" http://127.0.0.1:5679/webhook/qos-spike-hmac)"

log "Export round-trip:"
docker compose exec -T n8n sh -c 'rm -rf /tmp/exp && n8n export:workflow --backup --output=/tmp/exp && ls /tmp/exp' 2>&1 | tee -a out/results.txt
log "Done. Manual follow-ups: create an API key in the UI and retry /api/v1/executions; check MFA option for owner account; note what the -pc image tags are."
