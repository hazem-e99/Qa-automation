# ADR-0007 — Transactional outbox and inbox
- Status: Accepted · Date: 2026-11-09 · Deciders: Principal Architect

## Context
Domain changes must reliably trigger downstream work (n8n workflows, notifications, analytics) without the bugs that come from writing to two places that can disagree. Inbound provider events can arrive duplicated, out of order, or not at all.

## Decision
- **Outbox.** Every domain event goes into `outbox_events` in the same transaction as the state change. A class-E dispatcher publishes each event to internal subscribers and to the orchestrator, and records a `workflow_dispatches` row per subscription. Delivery is at-least-once, and receivers deduplicate on `event_id`.
- **Inbox.** Every webhook and every polled change is recorded in `inbox_messages` before any processing, with unique key `(connection_id, dedupe_key)`. The dedupe key is the provider's delivery ID, or a payload hash when there is none. The processor is idempotent. When the payload is unsigned or incomplete, it **re-fetches the authoritative state** from the provider instead of trusting the payload.
- The event envelope and catalog are defined in [19 §1](../19-workflow-specifications.md).

## Consequences
- (+) No lost or phantom events, and events can be replayed.
- (−) A small delay before events are published (well under a second, with LISTEN/NOTIFY to wake the dispatcher).
- (−) The tables grow over time; retention jobs keep them bounded.
