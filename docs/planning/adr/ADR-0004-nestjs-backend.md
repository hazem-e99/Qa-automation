# ADR-0004 — NestJS for the backend
- Status: Accepted · Date: 2026-11-09 · Deciders: Principal Architect, Staff Full-Stack Engineer

## Context
The backend needs modularity, dependency injection for ports and adapters, guards for RBAC, interceptors for audit and idempotency, and a mature testing story. A future company team must be able to maintain it.

## Decision
Use **NestJS** on the Fastify HTTP adapter. The version is 12 if spike T-P0-05 confirms the ecosystem is compatible, and 11 otherwise (OD-09).

Each Nest module maps 1:1 to a domain module. The domain code in `packages/domain` is **framework-free**: Nest is only the delivery and DI layer.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| Fastify with our own DI | Light | We would rebuild guards, modules, and testing conventions ourselves |
| Hono / Elysia | Fast, modern | Less enterprise structure |
| .NET (ASP.NET Core) | Strong fit with Azure in the enterprise | Different language from the frontend and Playwright tests; slower to iterate on solo |
| Next.js API routes only | One app | Couples the UI to the domain; poor fit for long-running work |

## Consequences
- (+) A structure enterprise teams already know, and DI makes adapters easy to swap.
- (−) The framework leans heavily on decorators. Keeping the domain framework-free limits how much we are locked in.

## Revisit when
The company standardizes on .NET for internal tools. Even then, the clean domain and port boundaries reduce the cost of migrating.
