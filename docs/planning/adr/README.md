# Architecture Decision Records

> Status: **Planned** · Format: lightweight MADR · Last reviewed: 2026-11-09

An ADR records one significant decision. A decision is significant if it is hard to reverse, would surprise a newcomer without context, or involved a real trade-off. ADRs are **immutable once Accepted**. To change a decision, write a new ADR that *supersedes* the old one and update the index below.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](ADR-0001-modular-monolith.md) | Modular monolith, multi-process deployment | Accepted |
| [0002](ADR-0002-hexagonal-capabilities.md) | Hexagonal ports with capability manifests | Accepted |
| [0003](ADR-0003-typescript-monorepo.md) | TypeScript monorepo (pnpm + Turborepo) | Accepted |
| [0004](ADR-0004-nestjs-backend.md) | NestJS for the backend | Accepted |
| [0005](ADR-0005-postgres-drizzle.md) | PostgreSQL as single source of truth; Drizzle ORM | Accepted |
| [0006](ADR-0006-pg-boss-queue.md) | pg-boss instead of Redis/BullMQ | Accepted |
| [0007](ADR-0007-outbox-inbox.md) | Transactional outbox and inbox | Accepted |
| [0008](ADR-0008-n8n-orchestrator.md) | n8n as the replaceable workflow orchestrator | Accepted |
| [0009](ADR-0009-test-code-location.md) | Test code location: dedicated QA repository by default | Accepted |
| [0010](ADR-0010-sandboxed-execution.md) | Sandboxed execution via a dedicated execution controller | Accepted |
| [0011](ADR-0011-object-storage.md) | Object storage: local filesystem, then S3-compatible; MinIO rejected | Accepted |
| [0012](ADR-0012-ai-gateway-bounded-tasks.md) | AI gateway with bounded tasks and an approval engine | Accepted |
| [0013](ADR-0013-python-parser-sidecar.md) | Python document-parser sidecar | Accepted (library pending OD-02) |
| [0014](ADR-0014-polling-first-ingress.md) | Polling-first event ingress with optional webhooks | Accepted |
| [0015](ADR-0015-authentication.md) | Local accounts first, OIDC-ready | Accepted |
| [0016](ADR-0016-nextjs-ui-only.md) | Next.js as UI and thin BFF only | Accepted |
| [0017](ADR-0017-orchestration-ownership.md) | Orchestration ownership: one workflow engine plus core essential operations | Accepted |
| [0018](ADR-0018-test-engine-vs-execution-backend.md) | Separate TestEngine (what runs) from ExecutionBackend (where it runs) | Accepted |
| [ADR-0019](ADR-0019-pilot-ai-provider-gemini.md) | Pilot AI provider: Gemini first, Claude second | Accepted |

## Template

```markdown
# ADR-NNNN — Title
- Status: Proposed | Accepted | Superseded by ADR-XXXX
- Date: YYYY-MM-DD
- Deciders: roles

## Context
## Decision
## Alternatives considered
## Consequences (positive / negative)
## Revisit when
```
