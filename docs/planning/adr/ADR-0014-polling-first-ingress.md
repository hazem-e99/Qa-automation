# ADR-0014 — Polling-first event ingress with optional webhooks
- Status: Accepted · Date: 2026-11-09

## Context
The pilot runs on a laptop that sleeps and sits behind NAT, so incoming connections are unreliable. Azure DevOps webhooks are not signed. Any webhook can be lost.

## Decision
- **Reconciliation polling is what guarantees correctness.** A class-E `sync.poll` job runs for each connection and role:
  - It resumes from a cursor such as `System.ChangedDate`, `updated_at`, or a commit SHA.
  - It uses the `stately` policy, keyed by connection.
- **Webhooks only lower latency.** A webhook triggers an immediate targeted sync. It never replaces polling.
- **Local webhook exposure is optional.** If enabled, a tunnel exposes **only** `/webhooks/*`, on a separate listener, with signature verification and rate limiting.
- **Catching up after offline periods.** When the machine comes back, `sync.poll` resumes from the stored cursor, pages through the changes, and backs off when it hits rate limits.

## Consequences
- (+) Data stays correct when the machine is offline or asleep, and no inbound exposure is required.
- (−) Without webhooks, a change can take up to one poll interval to arrive. The default interval is 5 min; the minimum is 1 min, depending on the provider's rate-limit budget.
