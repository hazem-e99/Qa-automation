# ADR-0008 — n8n as the (replaceable) workflow orchestrator
- Status: Accepted · Date: 2026-11-09 · Deciders: Principal Architect, DevOps Engineer · Related: [ADR-0017](ADR-0017-orchestration-ownership.md)

## Context
The owner wants a self-hosted n8n as the main orchestrator. The n8n Community Edition (CE) lacks Git version control, external secrets, SSO, and sharing ([36 N3](../36-technical-validation.md)). Using it inside the company under the Sustainable Use License (SUL) needs legal confirmation (OD-01).

## Decision
- n8n is **the only workflow engine** for configurable multi-step automation, covering class O and O-F work as defined in ADR-0017.
- It sits behind the `WorkflowOrchestrator` port. The adapter sends events to n8n webhooks, and n8n calls back into the QualityOS **Automation API** (`/automation/v1/*`).
- **n8n holds no business state** and never touches the QualityOS database. Its only required credential is one scoped QualityOS service token. Teams may add optional notification-channel credentials, such as a Teams webhook.
- Workflows are kept as code in `infra/n8n/workflows/*.json` with stable IDs. They are imported with the n8n CLI at deploy time and exported again after edits. CI fails if an exported workflow contains credentials or secrets.
- QA users configure automation inside QualityOS. The n8n workflow templates are parameterized by rule ID.

## Alternatives considered
- **Temporal**: heavy, and workflows are written only in code.
- **Windmill, Activepieces, Node-RED**: considered as alternative engines.
- **A built-in rules engine only**: the owner explicitly asked for n8n.

## Consequences
- (+) A visual, extensible automation layer that does not couple to the core.
- (−) Two runtimes to operate. The strict ownership model and contract tests on the Automation API keep this manageable.

## Revisit when
OD-01 is answered "no", or a CE limitation blocks a required workflow. In either case, implement another `WorkflowOrchestrator` adapter. The event contracts stay the same.
