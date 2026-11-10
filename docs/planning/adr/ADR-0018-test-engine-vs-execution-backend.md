# ADR-0018 — Separate TestEngine (what) from ExecutionBackend (where)
- Status: Accepted · Date: 2026-11-09

## Context
Playwright is the first test engine, but others will follow, such as API-only runners, k6, and engines for other languages. Runs may also execute in different places: local Docker, company CI, or a future runner pool.

## Decision
- The **`TestEngine` port** covers what runs. It:
  - discovers tests;
  - builds the run command and config;
  - parses results (JUnit/JSON) into the canonical `ExecutionResult`;
  - lists the artifact types it produces;
  - provides the strategy for visual comparison.
- The **`ExecutionBackend` port** covers where tests run. Given an engine-produced `RunSpec`, it provisions, starts, streams, cancels, collects, and tears down the environment.
- **Pairing.** Which engine can run on which backend is declared by capability. For example, `backend.local_docker` supports `engine.playwright@1`.
- **CI backend.** The CI backend triggers a pipeline, then ingests results through the same result contract as every other backend.

## Consequences
- (+) Adding a new engine does not require a new backend, and adding a new backend does not require a new engine.
- (−) `RunSpec` is slightly more abstract, so it is versioned in `@qos/contracts`.
