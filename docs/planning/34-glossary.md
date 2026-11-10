# 34 — Glossary

> Status: **Planned** · Owner: Documentation Lead · Last reviewed: 2026-11-09

These terms are used the same way across all planning documents. When a document uses one of these words, it means exactly the definition below.

## Product and domain terms

| Term | Definition |
|---|---|
| **QualityOS** | The platform described in this package. |
| **Organization** | Top-level tenant boundary. There is exactly one in the pilot. Multi-organization support is designed into the schema but not exposed (see [ADR-0001](adr/ADR-0001-modular-monolith.md), [28](28-enterprise-rollout.md)). |
| **Project** | The unit of isolation for configuration, data, members, and audit. Every domain record except users and organization settings belongs to exactly one project. |
| **Environment** | A named deployment target of the application under test (e.g. `dev`, `staging`), with a base URL, allowed hosts, and test-data settings. |
| **Requirement** | A canonical, source-independent statement of expected behavior. It has immutable **RequirementVersions**. |
| **Requirement Source** | A configured origin of requirements, such as an Azure Boards query, a document set, a spreadsheet mapping, or manual entry. A project may have many. |
| **Source Snapshot** | An immutable capture of one source item at a point in time: a document file version or a work-item revision. It carries a checksum. |
| **Extracted Item** | A candidate requirement or acceptance criterion produced from a snapshot. It has a *locator* (page, section, cell, or field) and a *confidence* score. |
| **Provenance** | The chain from a RequirementVersion back to the Extracted Items and Source Snapshots it came from. |
| **Acceptance Criterion (AC)** | A testable condition attached to a RequirementVersion. Its origin is `source` (stated in the source) or `inferred` (suggested by AI or a person, and needing explicit approval). |
| **Inferred** | A flag on any item proposed by AI or derived from context rather than stated in a source. Inferred items are never auto-approved. |
| **Requirement Conflict / Gap** | Analysis findings. A conflict is two statements that contradict each other. A gap is a missing condition (e.g. no error behavior defined). A human resolves both. |
| **Test Case** | A structured test specification (title, preconditions, steps, expected results, and so on) with immutable **TestCaseVersions**. It can be manual, automated, or both. |
| **Automation Binding** | The link between a TestCaseVersion and executable test code: repository path plus test title or tag. |
| **Test Suite** | A named, ordered collection of test cases. Suites can be static or dynamic (defined by a tag or query). |
| **Test Plan / Test Cycle** | A planned set of test cases to execute against a build or environment within a time window. In the manual workspace this is called a "Test Cycle". |
| **Test Run** | One execution request: a suite, cycle, or selection, run against one environment and build, with one engine and one backend. It is immutable once finalized. |
| **Test Execution** | One test case attempt inside a run (manual or automated). Retries create additional *attempts*. They never overwrite earlier ones. |
| **Test Result** | The outcome of an attempt: `passed`, `failed`, `skipped`, `blocked`, `errored`, `not_run`, or `cancelled`. |
| **Artifact** | A file produced by execution or attached as evidence: screenshot, video, trace, log, HAR, JUnit/JSON report, or diff image. |
| **Flaky** | A test whose outcome varies between attempts or runs without any change to code or configuration. See [29](29-business-case-and-kpis.md) for the formula. |
| **Failure Classification** | The category assigned to a failed attempt: `product_defect`, `test_defect`, `environment`, `infrastructure`, `data`, `flaky`, or `unknown`. |
| **Defect** | A QualityOS record of a suspected or confirmed product bug. It may be mirrored to an external tracker. |
| **Defect Draft** | An AI- or human-prepared defect report awaiting approval under the project's approval policy. |
| **Verification (of a defect)** | A retest that confirms a fix. Its outcome is `verified`, `failed_verification`, or `inconclusive`. |
| **Visual Baseline** | An approved reference screenshot, keyed by test, viewport, browser, locale/direction, and theme. |
| **Quality Gate** | A rule set evaluated against a run or build (e.g. "0 new product defects with severity ≥ high and smoke pass rate = 100%"). Its outcome is `pass`, `fail`, or `warn`. |
| **Approval Policy** | A per-project configuration that defines which actions need human approval, by which roles, and how many approvers. |
| **Traceability Link** | A typed, versioned edge between artifacts, for example `verifies` (TestCaseVersion → RequirementVersion), `detected_by` (Defect → Execution), or `fixes` (CodeChange → Defect). |

## Architecture terms

| Term | Definition |
|---|---|
| **Modular monolith** | A single deployable codebase with strictly enforced internal module boundaries. It is run as several processes (see [07](07-system-architecture.md)). |
| **Port** | A provider-neutral interface owned by the core domain (e.g. `IssueTracker`). |
| **Adapter** | A concrete implementation of a port for one provider (e.g. `AzureBoardsIssueTrackerAdapter`). |
| **Provider family** | One kind of external capability: source control, requirements, issue tracking, CI/CD, AI, storage, orchestration, test engine, execution backend, secrets, notifications. |
| **Provider type** | A specific provider within a family, e.g. `github`, `gitlab`, `azure_devops`, `local_git`. |
| **Capability** | A named, versioned feature that an adapter declares, e.g. `issues.create@1`. The core asks for capabilities, never for provider types. |
| **Capability manifest** | The static declaration of the capabilities an adapter supports, plus its limits. |
| **Connection** | A configured instance of a provider type: credentials, base URL, and scope. Connections live at organization level and are *bound* to projects in specific *roles*. |
| **Binding / Role binding** | Assigns a connection to a project role, e.g. `repository`, `test_repository`, `requirements`, `issue_tracker`, `ci`, `ai`, `notifications`. |
| **ExternalRef** | The provider-neutral record of an external object: `{connectionId, providerType, externalId, externalUrl, externalVersion, fetchedAt, snapshot}`. |
| **Outbox** | A table where domain events are written in the same transaction as the state change. A dispatcher job publishes them later. |
| **Inbox** | A table where inbound webhooks and polled changes are recorded and deduplicated before processing. |
| **Idempotency key** | A client-supplied key. Repeating a request with the same key returns the original result and causes no second effect. |
| **Essential operation (Class E)** | A fixed, code-defined background operation owned by the core and run by the job queue. It is never implemented in n8n. See [18](18-n8n-orchestration.md). |
| **Orchestrated workflow (Class O / O-F)** | A configurable multi-step automation run by the workflow orchestrator (n8n). Class O-F workflows have a minimal core fallback. Class O workflows do not. |
| **Firing / Slot** | A single scheduled trigger instance for an automation rule. The slot key identifies it uniquely (e.g. `2026-11-09T02:00Z`). |
| **Execution controller** | The dedicated process that turns run requests into sandboxed containers. It is the only component with (proxied) Docker API access. |
| **Test engine** | What runs the tests (Playwright initially). |
| **Execution backend** | Where the tests run: local Docker sandbox, CI provider, or a future remote runner pool. |
| **AI task** | A bounded, versioned LLM operation with typed input and output, e.g. `requirements.extract@v3`. |
| **AI Gateway** | The core service that runs AI tasks. It handles provider routing, redaction, budget checks, validation, and the usage ledger. |
| **Demo mode** | Running QualityOS with mock adapters and seed data. It needs no external credentials. |

## Abbreviations

AC = acceptance criterion · ADR = architecture decision record · BFF = backend for frontend · CE = (n8n) Community Edition · DLQ = dead-letter queue · E2E = end-to-end · KPI = key performance indicator · OIDC = OpenID Connect · PAT = personal access token · RBAC = role-based access control · RLS = (Postgres) row-level security · RTL/LTR = right-to-left / left-to-right · SSRF = server-side request forgery · SSO = single sign-on · SUL = (n8n) Sustainable Use License.
