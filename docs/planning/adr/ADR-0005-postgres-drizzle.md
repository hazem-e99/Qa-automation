# ADR-0005 — PostgreSQL as single source of truth; Drizzle ORM
- Status: Accepted · Date: 2026-11-09 · Deciders: Database Architect

## Context
We need relational integrity for the traceability graph and versions, JSONB for provider snapshots, full-text search, vector similarity, an append-only audit log, and a job queue. We want all of this without adding more infrastructure.

## Decision
- **PostgreSQL 17** stores everything: domain data, the pg-boss schema, the outbox and inbox, the audit log, and embeddings (pgvector). Locally it runs on the image `pgvector/pgvector:pg17`.
- **Drizzle ORM** defines the schema in TypeScript and generates SQL migrations, which are committed and reviewed. Migrations for triggers, RLS, and partitions are written by hand in SQL.
- Migrations run through an explicit `migrate` command. They never run automatically when the application starts in production.
- Primary keys are **UUIDv7**: they are time-ordered and globally unique.

## Alternatives considered
- **Prisma**: heavier, and weaker for hand-tuned SQL.
- **Kysely**: no schema or migration tooling.
- **TypeORM**: couples the domain to the framework.

## Consequences
- (+) One store to back up, monitor, and secure.
- (−) Postgres becomes critical. Backups and restore tests are therefore mandatory ([22](../22-observability-and-reliability.md)).

## Revisit when
Analytics queries hurt transactional latency. At that point, add read replicas or a separate analytics store fed from the outbox.
