# T-P0-04 — Playwright sandbox on this machine — 2026-11-10

**Run:** `bash run.sh 50` from Git Bash. Docker Desktop 4.99 (Engine 29.9.3, WSL2 backend, data on D:), VM with 12 CPUs and 7.6 GiB. Image `mcr.microsoft.com/playwright:v1.65.0-noble` (3.63 GB) with `@playwright/test` 1.65.0.

**Flags per run:** `--user pwuser`, Playwright seccomp profile, `no-new-privileges`, `--cap-drop ALL`, `--read-only` with tmpfs `/tmp` and `/work`, `--shm-size 1g`, `--init`, 3 GB memory, 2 CPUs, 512 PIDs, internal-only network, egress through Squid. Test code enters as a tar stream on stdin; no host mounts.

## Result
| Item | Result |
|---|---|
| Runs passing all 4 tests | **50 / 50** |
| OOM kills | 0 |
| Time per run (npm install + 4 tests) | average 6.7 s, min 5 s, max 28 s (first run) |
| Chromium as non-root under seccomp, read-only rootfs | Works; Arabic RTL page test passes |
| Allow-listed host through the proxy | 200 |
| Non-allow-listed host and internet host | 403 from Squid (`ERR_ACCESS_DENIED`) |
| Direct TCP to another network, metadata IP, `host.docker.internal:2375` | Not reachable |
| Docker socket inside the sandbox | Absent |
| Write to rootfs | Fails; process is not root |

## Socket proxy (`tecnativa/docker-socket-proxy:v0.5.0`, `CONTAINERS=1 IMAGES=1 POST=1`, rest 0)
| Call | Result |
|---|---|
| List containers | 200 |
| Build, volumes | 403 |
| Create an exec on a container | **201 — allowed** (falls under the containers rule) |
| Start that exec | 403, so the exec never runs |
| Create a container with `Privileged: true` and a host bind `/:/host` | **201 — allowed** |

**Finding (security):** the proxy filters by URL path and method only, never by request body. It does not stop a privileged or host-mounting container from being created. It narrows the API surface, but it is **not** a defence against a compromised execution controller.
Consequences for the design (ADR-0010, doc 16, doc 21):
- The execution controller builds the container spec from a fixed template; no caller-supplied field reaches `HostConfig`.
- Add a spec check in the controller with tests for privileged, binds, capabilities, network and PID mode (new hardening task for P6/P11).
- Evaluate a body-validating alternative (an authorisation plugin or a small allow-list proxy) at P11. Until then the documented trust boundary is "controller is trusted, sandboxes are not".

## Fixes made to the spike while running
- Squid: removed `access_log stdio:/dev/stdout` (the image's non-root Squid cannot open it and exits).
- Tar extraction into the tmpfs needs `--no-overwrite-dir -m --no-same-owner` under `--cap-drop ALL`.
- Git Bash on Windows: `MSYS_NO_PATHCONV=1` and a Windows-style path for the seccomp file.
- Squid closes the connection on a 403 and the Playwright API client sometimes reports it as "aborted" (1 of the first 2 trial runs). The test now accepts both forms. Product code that probes egress denial must do the same.

## Not covered
- Parallel runs (the plan is 2 at a time on this machine) and memory under parallel load.
- Firefox and WebKit; only Chromium ran.
- HTTPS targets through the proxy (CONNECT to an allow-listed host on 443 was exercised only for the npm registry).
- npm install ran inside the sandbox through the proxy. The product design pre-installs dependencies in the project image instead.
