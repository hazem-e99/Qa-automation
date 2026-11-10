# ADR-0001 — Modular monolith, multi-process deployment
- Status: Accepted · Date: 2026-11-09 · Deciders: Principal Architect, Platform Engineer

## Context
QualityOS has about 14 functional modules. One developer builds the pilot on a laptop. The company target is tens of projects and roughly 5–50 QA users, which is internal-tool scale, not internet scale. What matters most is module independence, replaceable providers, and dependable background processing.

## Decision
Build **one TypeScript codebase** with strictly separated domain modules ([07 §3](../07-system-architecture.md)). Deploy it as **several processes** from the same build:

- `api`: HTTP API, authentication, and webhook intake.
- `worker`: pg-boss consumers for sync, AI, outbox dispatch, analytics, and maintenance.
- `execution-controller`: turns run requests into sandboxed containers. It is the only component that can reach Docker.
- `web`: the Next.js UI.
- `parser`: a Python sidecar ([ADR-0013](ADR-0013-python-parser-sidecar.md)).

Module boundaries are enforced in CI by dependency-cruiser. Modules communicate only through their public application services or through domain events. They never read each other's tables.

## Alternatives considered
- **Microservices.** They bring independent scaling, but also distributed transactions, network calls between modules, service discovery, and one deploy pipeline per service. That operational cost is not justified at this scale and team size.
- **A single process.** This is the simplest option, but a runaway Playwright run or a large PDF parse could starve the API. Splitting into separate processes avoids that cheaply.

## Consequences
- (+) One repository and one migration history. Local transactions across modules remain possible when truly needed, which should be rare.
- (+) Any module can later be extracted into a service, because its boundaries and event contracts are already explicit.
- (−) Boundaries depend on discipline, backed by CI lint rules and code review.
- (−) All processes share one database. That is acceptable at this scale, with connection-pool budgets set in [22](../22-observability-and-reliability.md).

## Revisit when
There are more than about 200 concurrent users, separate teams own modules, or modules need independent release cadences.
