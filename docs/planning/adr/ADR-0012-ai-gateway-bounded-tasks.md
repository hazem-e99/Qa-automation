# ADR-0012 — AI gateway with bounded tasks and an approval engine
- Status: Accepted · Date: 2026-11-09 · Deciders: Senior AI Engineer, Security Architect, QA Lead

## Context
AI does central work in QualityOS: requirements analysis, test design, code generation, and failure analysis. But its output can be wrong, it can be manipulated by injected content, and every call costs money. Each project must be able to choose and replace its AI provider.

## Decision
- **No free-roaming agents in the core.** All AI work comes from a catalog of **bounded tasks**, each identified as `taskId@version`. A task has:
  - typed input
  - JSON-Schema output
  - a versioned prompt template
  - an evaluation dataset
  - a cost class

  The full catalog is in [15](../15-ai-agent-architecture.md).
- The **AI Gateway** runs every task. For each call it:
  1. routes to the right provider
  2. redacts sensitive data
  3. checks the budget
  4. renders the prompt
  5. makes the call
  6. validates the output against the schema, retrying with a repair prompt if needed
  7. writes a ledger entry and an `ai_executions` record
- Agentic tools (Claude Code, Playwright Test Agents) run **only inside the code-generation sandbox**. Their only output is a branch and a PR.
- AI output is always a **suggestion**. Changes to authoritative state go through the **Approval Policy Engine** ([16 §6](../16-test-management-engine.md), [M14](../modules/M14-security-audit-settings.md)).
- Untrusted content goes only into delimited data sections of the prompt, and that content never comes with tool permissions.

## Consequences
- (+) Cost and behavior are predictable, and every call can be audited and tested.
- (−) There is less "magic": multi-step reasoning has to be composed explicitly in code.
