#!/usr/bin/env bash
# T-P0-04: run the sandbox N times with the planned hardening flags and record results.
# Usage: ./run.sh [N=50]      (requires Docker; run from spikes/sandbox)
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: do not rewrite /tmp, /work paths
HERE="$(pwd -W 2>/dev/null || pwd)"
N="${1:-50}"
IMAGE="mcr.microsoft.com/playwright:v1.65.0-noble"
mkdir -p out
[ -f seccomp_profile.json ] || curl -fsSL -o seccomp_profile.json \
  https://raw.githubusercontent.com/microsoft/playwright/v1.65.0/utils/docker/seccomp_profile.json

docker compose up -d --wait
docker pull -q "$IMAGE"

# Tests are copied in via a tar stream on stdin (no host bind mounts into the sandbox).
echo "run,exit_code,seconds,oom" > out/results.csv
for i in $(seq 1 "$N"); do
  start=$(date +%s)
  name="spike-sbx-$i"
  set +e
  tar -C tests -cf - . | docker run --name "$name" -i \
    --network spike-sbx \
    --user pwuser \
    --security-opt "seccomp=$HERE/seccomp_profile.json" \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --read-only --tmpfs /tmp:rw,size=1g --tmpfs /work:rw,exec,size=1g,uid=1000,gid=1000 \
    --shm-size 1g --init \
    --memory 3g --memory-swap 3g --cpus 2 --pids-limit 512 \
    -e HOME=/tmp -e npm_config_cache=/tmp/npm \
    -e HTTP_PROXY=http://squid:3128 -e HTTPS_PROXY=http://squid:3128 -e NO_PROXY= \
    --label qualityos.spike=sandbox \
    "$IMAGE" bash -c 'cd /work && tar -xf - --no-overwrite-dir -m --no-same-owner && npm install --no-audit --no-fund --loglevel=error && npx playwright test'
  code=$?
  set -e
  oom=$(docker inspect -f '{{.State.OOMKilled}}' "$name" 2>/dev/null || echo unknown)
  docker logs "$name" > "out/run-$i.log" 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "$i,$code,$(( $(date +%s) - start )),$oom" | tee -a out/results.csv
done

# Socket proxy restrictions: exec and build must be denied (403), container list allowed (200).
{
  echo "list=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:23750/containers/json)"
  echo "exec=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:23750/containers/spike/exec)"
  echo "build=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:23750/build)"
  echo "volumes=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:23750/volumes)"
} | tee out/socket-proxy.txt

passed=$(awk -F, 'NR>1 && $2==0' out/results.csv | wc -l)
echo "PASSED $passed / $N"
