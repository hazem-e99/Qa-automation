# ADR-0010 — Sandboxed execution via a dedicated execution controller
- Status: Accepted · Date: 2026-11-09 · Deciders: Security Architect, QA Automation Architect, Platform Engineer

## Context
Test code comes from repositories and may be AI-generated, so it is **untrusted**. It installs npm packages and drives browsers. It must not be able to reach host files, the Docker daemon, the QualityOS database, or secrets.

## Decision
- A dedicated **execution-controller** process consumes `execution.run.requested` jobs. It is the only component that can reach the container runtime, and it does so through a **Docker socket proxy**.
  - The proxy allows only container create, start, stop, inspect, logs, and wait, and only on the `qos-sandbox` network.
  - It blocks image builds, `exec`, bind mounts, and privileged containers.
- Each run gets an **ephemeral container** built from the Playwright image whose version matches the repository's `@playwright/test` version. The container:
  - runs as the non-root `pwuser`, with Playwright's seccomp profile, `--init`, and `--shm-size=1g`;
  - has a read-only root filesystem, with tmpfs mounted at `/work` and `/tmp`;
  - has CPU, memory, and PID limits and a wall-clock timeout;
  - sets `no-new-privileges` and drops all Linux capabilities.
- Test code reaches the container **as an archive of the exact commit, streamed by the API**. The sandbox downloads it with a per-run, read-only token. This is the default for every provider, so the sandbox never receives a provider credential. An in-container `git clone` with a provider-minted, short-lived, read-only token (e.g. a GitHub App installation token) is an optional optimization. There are no host bind mounts.
- **Egress** goes through an egress proxy that allows only the run's environment hosts and the package-registry mirror.
- Results and artifacts leave the container through an upload endpoint, using a **per-run, expiring token that can only upload**.
- When the controller restarts, it reconciles running containers using the label `qualityos.run_id`.
- Details are in [17](../17-test-execution-engine.md).

## Alternatives considered
- **Running Playwright inside the worker**: no isolation.
- **Docker-in-Docker**: requires privileged containers.
- **gVisor or Kata**: stronger isolation, but hard to set up on Windows. These are an option when hardening for the enterprise.
- **Running tests only in CI**: no local runs.

## Consequences
- (+) A compromised test cannot reach the host or QualityOS internals.
- (−) The pilot requires Docker Desktop, and the first run of each Playwright version waits for its image to download. Images are cached after that.

- (−) **Measured in T-P0-04 (2026-11-10):** the socket proxy filters by URL path only. It allowed creating a privileged container with a host bind. So the proxy narrows the API but does not contain a compromised controller. The controller must validate its own container spec (T-P6-24); a body-validating proxy is evaluated in P11.

## Revisit when
QualityOS moves to the company server. Then consider gVisor (`runsc`) or a Kubernetes Jobs backend (OD-12).
