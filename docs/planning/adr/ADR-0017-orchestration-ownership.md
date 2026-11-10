# ADR-0017 — Orchestration ownership: one workflow engine + core essential operations
- Status: Accepted · Date: 2026-11-09 · Deciders: Principal Architect, DevOps Engineer, QA Lead

## Context
The owner approved two things: n8n as the main orchestrator, **and** an internal fallback for essential scheduling and job processing. They explicitly do **not** want two workflow engines competing with each other. PostgreSQL must remain the source of truth.

## Decision
Automated work falls into three classes (full specification in [18](../18-n8n-orchestration.md)):

| Class | Owner | Definition |
|---|---|---|
| **E: Essential operation** | Core, via pg-boss | A fixed operation defined in code that correctness or data integrity depends on. Users cannot configure it as a flow. It is **never** implemented in n8n. |
| **O-F: Orchestrated with fallback** | n8n first; core as fallback | An automation the user configures, whose *minimal outcome* must not be missed (for example, a test run must still be created). If n8n fails, the core performs only that minimal outcome and posts an in-app notification. |
| **O: Orchestrated only** | n8n | Enrichment, notification fan-out, report delivery, and custom recipes. While n8n is down, these dispatches wait in a durable queue. |

Five rules stop the core from turning into a second engine:
1. **Closed list of fallback actions.** The core fallback can perform only the O-F actions defined in code: `run.create` and `retest.create`. It has no branching, no user-defined steps, and no editor.
2. **Schedules live in Postgres, and slots are claimed.** Automation rules are stored in Postgres. Whoever fires a slot must claim it by inserting into `automation_firings(rule_id, slot_key)`, which has a UNIQUE constraint. So each slot fires at most once.
3. **The core fires a slot only as a last resort.** It fires an O-F slot only when the slot is unclaimed **and** one of these holds:
   - `now > slot + grace`, and the orchestrator's status has been `down` or `degraded` for at least the grace period;
   - `now > slot + 2 × grace` (safety net for an orchestrator that reports healthy but does not fire).
4. **Side effects go through the Automation API only.** That API is idempotent, and n8n has no database access.
5. **The core owns `automation_runs`.** n8n execution IDs are stored there only as external references.

## Consequences
- (+) Workflows are designed in one place, the core still guarantees correctness, and no run is ever duplicated.
- (−) The fallback is deliberately minimal, so notifications are delayed while n8n is down. The UI shows this delay.
