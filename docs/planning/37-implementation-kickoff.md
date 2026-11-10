# 37 — Implementation Kickoff (instructions for a new Claude Code session)

> Status: **Planned** · Use this **only after the owner has explicitly approved this planning package.** Until then, no code, scaffolding, installs, containers, or external configuration.

## 1. Preconditions
1. The owner has approved the planning package in writing. Record the approval date in `docs/status/IMPLEMENTATION_STATUS.md` once that file exists in P1.
2. The repository is initialized with git, and a remote is created on GitHub (private).
3. Docker Desktop is installed, with the WSL2 backend and ≥ 16 GB RAM given to WSL. Node 24 LTS and pnpm are installed. The owner does this themself.
4. Personal accounts are available: a GitHub test repository for the pilot, an Azure DevOps personal organization, and an Anthropic API key. **Never company credentials.**

## 2. Session opening prompt (copy into the new session)
```text
You are implementing QualityOS strictly according to the approved planning package in docs/planning/.
Read, in order: docs/planning/README.md, 01, 07, 11, 12, 17, 18, 21, 25, 26, 36, 37, and the ADRs in docs/planning/adr/.
Rules:
- Work phase by phase in the order of docs/planning/25-implementation-roadmap.md, task by task from 26-task-breakdown.md.
- Start with Phase 0 spikes (T-P0-01…06). Do not start P1 until P0 results are recorded in 36-technical-validation.md and OD-02/OD-09 are decided.
- For each task: restate its Verify criterion, implement with tests, run the tests, update docs/status/IMPLEMENTATION_STATUS.md (planned → in_progress → implemented → verified) with evidence.
- Respect the architecture fitness functions (07 §9): no provider names in core modules, modules talk via public services/events, domain is framework-free.
- Never use company data or credentials. Never push to default branches of real repositories from QualityOS code paths. Never disable sandbox controls.
- If a planning decision proves wrong, stop and propose an ADR (superseding) instead of silently diverging.
- Ask before installing anything not listed in 08-technology-decisions.md.
```

## 3. Proposed `CLAUDE.md` for the implementation repository (create in P1, T-P1-01)
```markdown
# QualityOS — engineering rules for agents and humans
Source of truth for design: docs/planning/ (ADRs in docs/planning/adr/). Status: docs/status/IMPLEMENTATION_STATUS.md.

## Architecture invariants
- Modular monolith; modules in packages/modules/*; cross-module calls only via each module's index.ts or domain events.
- Domain code is framework-free (no @nestjs, drizzle, adapters).
- Core code never references provider types (github/gitlab/azure/n8n/anthropic/playwright). Ask for capabilities via ProviderRegistry.
- Every project-owned query takes a ProjectScope.
- All consumers are idempotent (at-least-once). Use expected-state transitions and unique keys.
- Domain events go through the outbox in the same transaction as the state change.
- External mutations require the Approval Policy Engine + idempotency key + audit.
- Untrusted code runs only in sandboxes via execution-controller. Never mount host paths or the Docker socket elsewhere.
- AI only through the AI Gateway with registered, versioned tasks and schema validation.

## Workflow
- Pick the next task ID from docs/planning/26-task-breakdown.md; follow its Verify column.
- Tests first for domain logic; contract suites for adapters; E2E in demo mode for journeys.
- Commands: pnpm lint · pnpm typecheck · pnpm test · pnpm test:integration · pnpm test:contract · pnpm e2e:demo
- Keep PRs small (one task or a tight group). Update IMPLEMENTATION_STATUS.md in the same PR.

## Safety
- No company data/credentials. Secrets only in ./secrets (gitignored) or SecretStore.
- Do not weaken: sandbox settings, egress allowlists, branch-prefix rules, approval policies, redaction.
```

## 4. First ten concrete steps after approval
1. **T-P0-05:** pin versions and verify licenses. Update 36.
2. **T-P0-02:** pg-boss and Drizzle transactional proof.
3. **T-P0-04:** sandbox stability spike on the pilot machine. It is the highest technical risk.
4. **T-P0-03:** n8n CE behavior spike.
5. **T-P0-01:** parser bake-off on the AR/EN corpus. Assemble the corpus first, from synthetic and personal documents.
6. **T-P0-06:** Claude structured output and cost spike, plus the embeddings provider choice.
7. Gate P0. Update the ADRs if needed (ADR-0013 library, OD-09), then re-estimate the roadmap.
8. **T-P1-01…03:** monorepo, fitness functions, contracts.
9. **T-P1-04…09:** composition roots, DB and migrations, pg-boss, outbox, inbox, idempotency.
10. **T-P1-10…16:** observability, health, storage, Compose `core`, web shell, CI, status file. Then gate P1.

## 5. Working agreements for agent sessions
- One phase per session series. Start each session by reading the status file and the phase section in 25.
- After each task, run the full relevant test level, and attach the evidence (test output summary) to the status entry.
- Use subagents only for broad searches or independent reviews. Avoid parallel writers on the same files.
- At each phase gate, write `docs/status/gates/P<n>.md`. Use the [35](35-planning-audit.md) checklist style.
