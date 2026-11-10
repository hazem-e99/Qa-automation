# ADR-0002 — Hexagonal ports with capability manifests
- Status: Accepted · Date: 2026-11-09 · Deciders: Principal Architect, Enterprise Integration Architect

## Context
Each project may use different providers for source control, requirements, issue tracking, CI, AI, storage, orchestration, test engines, and execution backends. Switching providers must not require rewriting business logic. Providers also differ in what they can do: Azure Boards has rich custom fields, GitHub Issues has labels, and Local Git has no pull requests.

## Decision
- The core domain defines **ports** (TypeScript interfaces) for each provider family, and adapters implement them ([11](../11-provider-architecture.md), [12](../12-provider-contracts.md)).
- Every adapter publishes a **capability manifest**: a list of `capability@version` entries plus limits such as rate limits, maximum attachment size, and supported field types.
- Core services **ask for capabilities, never for provider types**. A lint rule rejects any `if (provider === 'github')` in domain or application code.
- A **ProviderRegistry** resolves `(projectId, role)` to a connection, then to an adapter.
- When a capability is missing, the system degrades explicitly. For example, without `repo.pr.create`, generated code is offered as a patch download. The UI shows these limits *before* a configuration is committed.
- Every port has a **mock adapter** and a **shared contract test suite** that every real adapter must pass ([24 §5](../24-testing-strategy.md)).

## Alternatives considered
- **One generic "integration" interface.** Too vague, and it pushes provider-specific logic into the callers.
- **Calling provider SDKs directly from services.** This is the fastest way to start, but it locks the product to vendors, which violates Rule 4.

## Consequences
- (+) Switching providers becomes a configuration change, and differences between providers are visible instead of hidden.
- (−) More up-front code: ports, mocks, and contract tests. It pays back with the second adapter and makes demo mode possible.

## Revisit when
A provider needs something that cannot be expressed without leaking provider concepts into the domain. The answer is to add a new capability, not to special-case that provider.
