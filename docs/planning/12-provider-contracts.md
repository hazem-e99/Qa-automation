# 12 — Provider Contracts

> Status: **Planned** · Owner: Enterprise Integration Architect · Architecture: [11](11-provider-architecture.md) · Tests: [24 §5](24-testing-strategy.md)

The interfaces below are **design sketches**. They fix names, shapes, and semantics. The final signatures go in `@qos/ports`, and their payload schemas go in `@qos/contracts`, both using Zod.

## 1. Common types
```ts
type CapabilityId = `${string}@${number}`;            // e.g. "issues.create@1"
interface CapabilityManifest {
  providerType: string; family: ProviderFamily; adapterVersion: string;
  capabilities: CapabilityId[];
  limits: { maxAttachmentBytes?: number; maxPageSize?: number; rateLimitHint?: string;
            richText?: 'markdown' | 'html' | 'plain'; [k: string]: unknown };
  authStrategies: AuthStrategy[];                     // 'pat' | 'github_app' | 'entra_client_credentials' | 'api_key' | 'basic' | 'none'
  webhook?: { verification: 'hmac_sha256' | 'shared_token' | 'basic_auth' | 'none'; deliveryIdHeader?: string };
}
interface ConnectionContext { connectionId: string; http: SafeHttpClient; secrets: ScopedSecretAccessor;
  log: RedactingLogger; clock: Clock; metrics: Metrics; rateLimiter: RateLimiter; }
interface ExternalRefData { externalType: string; externalId: string; externalUrl?: string;
  externalVersion?: string; snapshot: Record<string, unknown>; }
type Page<T> = { items: T[]; nextCursor?: string };
class ProviderError extends Error { kind: 'auth_failed'|'permission_denied'|'not_found'|'conflict'|
  'rate_limited'|'validation'|'unavailable'|'timeout'|'unknown'; retryAfterMs?: number; providerCode?: string; field?: string }
interface ConnectionTestResult { identity: string; scopesDiscovered: string[];
  permissionChecks: { capability: CapabilityId; ok: boolean; missing?: string }[]; expiresAt?: string }
```
Every adapter implements `testConnection(ctx): Promise<ConnectionTestResult>`.

## 2. Capability catalog
| Family | Capability | Meaning |
|---|---|---|
| source_control | `repo.read@1` | List repos, read files at ref, list branches |
| | `repo.commits.list@1` | Commits on a branch since a cursor, with messages and changed paths |
| | `repo.diff.read@1` | Changed files between two refs |
| | `repo.branch.create@1` | Create a branch from a ref |
| | `repo.commit.push@1` | Push commits (via git transport with a scoped token) |
| | `repo.pr.create@1` / `repo.pr.read@1` / `repo.pr.comment@1` | Pull/merge requests |
| | `repo.branch.protection.read@1` | Read protection rules |
| | `repo.checks.report@1` | Post a commit status or check run |
| | `repo.clone_token.issue@1` | Mint a short-lived read-only token, or supply a deploy key, for sandbox clones |
| | `repo.webhooks.manage@1` | Register and remove webhooks |
| requirements | `requirements.list_changed@1` | Items changed since a cursor (paged) |
| | `requirements.get@1` | Get one item (current state) |
| | `requirements.revisions@1` | Get a specific revision |
| | `requirements.links@1` | Parent/child/related links |
| | `requirements.attachments.read@1` | List and download attachments |
| | `requirements.query.validate@1` | Validate a query/filter (e.g. WIQL) |
| issue_tracking | `issues.metadata.read@1` | Types, states, fields, required fields |
| | `issues.create@1` / `issues.get@1` / `issues.update@1` | CRUD for the canonical issue |
| | `issues.list_changed@1` | Changed since a cursor |
| | `issues.comment@1` | Add a comment |
| | `issues.attachments.create@1` | Upload an attachment |
| | `issues.transition@1` | Change workflow state |
| | `issues.search_by_marker@1` | Find an issue by an embedded marker (idempotency recovery) |
| | `issues.links@1` | Link issues |
| ci | `ci.pipeline.trigger@1` | Start a pipeline with variables |
| | `ci.pipeline.status@1` | Status of a pipeline run |
| | `ci.artifacts.read@1` | Download artifacts (e.g. JUnit) |
| | `ci.events.deployments@1` | Deployment events (poll or webhook) |
| | `ci.status.report@1` | Report a gate result to the commit/MR |
| ai | `ai.generate.structured@1` | JSON-schema constrained generation |
| | `ai.generate.text@1` | Free text (narratives) |
| | `ai.embed@1` | Embeddings |
| | `ai.vision@1` | Image input (screenshots, scanned pages) |
| | `ai.tools@1` | Tool-calling loop (used only in sandbox code generation) |
| | `ai.prompt_cache@1` | Provider-side prompt caching |
| storage | `storage.put@1` / `storage.get@1` / `storage.delete@1` / `storage.signed_url@1` / `storage.list@1` | Blob ops |
| orchestration | `orchestrator.dispatch@1` | Send an event to a workflow endpoint |
| | `orchestrator.health@1` | Health probe |
| | `orchestrator.templates.deploy@1` | Deploy workflow definitions |
| | `orchestrator.executions.read@1` | Read execution status (optional) |
| test_engine | `engine.discover@1` | List tests and tags in a repo checkout |
| | `engine.runspec@1` | Build the run command, config, and env for a selection |
| | `engine.results.parse@1` | Parse native reports into canonical results |
| | `engine.trace@1` | Produce and viewer-serve traces |
| | `engine.visual_compare@1` | Screenshot comparison with baselines |
| | `engine.codegen@1` | Supports AI/agent-assisted code generation workflow |
| execution_backend | `backend.provision@1` / `backend.cancel@1` / `backend.logs.stream@1` / `backend.collect@1` / `backend.reconcile@1` | Lifecycle |
| | `backend.supports.engine.<engine>@1` | Engine pairing |
| secrets | `secrets.put@1` / `secrets.get@1` / `secrets.rotate@1` / `secrets.delete@1` | — |
| notifications | `notify.send@1` | — |
| identity | `identity.login@1` / `identity.oidc@1` / `identity.groups@1` | — |

## 3. Required capabilities per role
| Role | Required | Optional (with fallback) |
|---|---|---|
| `repository` | `repo.read`, `repo.commits.list` | `repo.diff.read` (impact analysis falls back to tag/suite selection), `repo.webhooks.manage` (manual webhook setup), `repo.checks.report` (no CI status post) |
| `test_repository` | `repo.read`, `repo.clone_token.issue` | `repo.branch.create` + `repo.commit.push` + `repo.pr.create` (otherwise generated code is delivered as a patch download), `repo.branch.protection.read` (always refuses the default branch anyway) |
| `requirements` (external) | `requirements.list_changed`, `requirements.get` | `requirements.revisions` (fallback: snapshot by content hash), `requirements.links`, `requirements.attachments.read` |
| `issue_tracker` | `issues.metadata.read`, `issues.create`, `issues.get`, `issues.update`, `issues.list_changed` | `issues.search_by_marker` (fallback: local idempotency only plus a manual reconcile prompt after a timeout), `issues.comment`, `issues.attachments.create`, `issues.transition` |
| `ci` | `ci.pipeline.status` + (`ci.pipeline.trigger` or `ci.events.deployments`) | `ci.artifacts.read`, `ci.status.report` |
| `ai` | `ai.generate.structured` | `ai.embed` (fallback: trigram similarity), `ai.vision`, `ai.tools` (needed only for agentic code generation), `ai.prompt_cache` |
| `orchestrator` | `orchestrator.dispatch`, `orchestrator.health` | `orchestrator.templates.deploy`, `orchestrator.executions.read` |

## 4. Port sketches
### 4.1 RepositoryProvider
```ts
interface RepositoryProvider {
  manifest(): CapabilityManifest;
  testConnection(ctx): Promise<ConnectionTestResult>;
  listResources(ctx, q: { search?: string; cursor?: string }): Promise<Page<RepoSummary>>;   // stable numeric/GUID id + path
  getRepo(ctx, repoId: string): Promise<RepoInfo>;                       // default branch, url, visibility
  readFile(ctx, repoId, path, ref): Promise<Uint8Array | null>;
  listCommits(ctx, repoId, branch, sinceCursor?): Promise<Page<CanonicalCommit>>;  // sha, message, author, timestamp, changedPaths?
  diff?(ctx, repoId, baseRef, headRef): Promise<ChangedFile[]>;
  createBranch?(ctx, repoId, name /* must start with qos/ */, fromRef): Promise<ExternalRefData>;
  pushCommits?(ctx, repoId, branch, patch: GitPatchBundle): Promise<{ headSha: string }>;
  createPullRequest?(ctx, repoId, req: { head; base; title; body; draft; labels? }, idemKey): Promise<ExternalRefData>;
  getPullRequest?(ctx, repoId, prId): Promise<CanonicalPullRequest>;      // state open|merged|closed, mergeSha
  commentPullRequest?(ctx, repoId, prId, markdown): Promise<void>;
  getBranchProtection?(ctx, repoId, branch): Promise<{ protected: boolean; rules?: string[] }>;
  issueCloneCredential(ctx, repoId, ttlSeconds): Promise<CloneCredential>; // {url, username?, token, expiresAt} read-only
  reportCheck?(ctx, repoId, sha, check: { name; state; summary; detailsUrl }): Promise<void>;
  manageWebhook?(ctx, repoId, action: 'register'|'remove', endpoint): Promise<void>;
}
```
Semantics:
- `createBranch` and `pushCommits` **must reject** any branch without the `qos/` prefix, and must reject the default branch. The contract suite tests this.
- `issueCloneCredential` returns read-only credentials only. Adapters that cannot scope tokens (e.g. a classic PAT) must use a deploy key, or proxy the clone through QualityOS ([17 §6](17-test-execution-engine.md)).

### 4.2 RequirementsSource
```ts
interface RequirementsSource {
  manifest(); testConnection(ctx);
  validateQuery?(ctx, config: SourceConfig): Promise<{ ok: boolean; estimatedCount?: number; error?: string }>;
  listChanged(ctx, config, cursor?: string): Promise<Page<SourceItemHeader> & { nextCursor: string }>;
  getItem(ctx, config, externalId: string, revision?: string): Promise<SourceItem>;
  // SourceItem: { externalId, revision, type, title, descriptionHtml|Markdown, acceptanceCriteriaText?,
  //   state, tags[], area?, iteration?, links[], attachments[], changedAt, url, rawFields (allowlisted) }
  listAttachments?(ctx, config, externalId): Promise<AttachmentMeta[]>;
  downloadAttachment?(ctx, config, attachmentId): Promise<Readable>;
}
```
Document sources (`document_set`, `spreadsheet`) and `manual` are **internal implementations of the same port**. Their `listChanged` returns uploaded snapshots, so downstream normalization is identical.

### 4.3 IssueTracker
```ts
interface CanonicalIssue {
  marker: string;                    // "[QOS:PRJ-D-12]" embedded for idempotent recovery
  type: string;                      // canonical 'bug' mapped via type mapping
  title: string; bodyMarkdown: string;
  severity?: string; priority?: string; labels?: string[];
  fields?: Record<string, unknown>;  // mapped custom fields
  links?: { kind: 'related'|'parent'; externalRef: ExternalRefData }[];
}
interface IssueTracker {
  manifest(); testConnection(ctx);
  getMetadata(ctx, scope): Promise<TrackerMetadata>;   // types, states (with categories), fields (required?), priorities
  createIssue(ctx, scope, issue: CanonicalIssue, idemKey: string): Promise<ExternalRefData>;
  getIssue(ctx, scope, externalId): Promise<CanonicalIssueState>;  // state, assignee, updatedAt, url
  updateIssue(ctx, scope, externalId, patch: Partial<CanonicalIssue>, expectedVersion?): Promise<ExternalRefData>;
  listChanged(ctx, scope, cursor?): Promise<Page<CanonicalIssueState> & { nextCursor: string }>;
  comment?(ctx, scope, externalId, markdown): Promise<void>;
  attach?(ctx, scope, externalId, file: { name; mime; bytes }): Promise<void>;
  transition?(ctx, scope, externalId, toState): Promise<void>;
  searchByMarker?(ctx, scope, marker): Promise<ExternalRefData | null>;
}
```
The internal tracker implements this port against QualityOS tables. It is the reference implementation, and it is always available.

### 4.4 CIProvider
```ts
interface CIProvider {
  manifest(); testConnection(ctx);
  triggerPipeline?(ctx, scope, req: { ref; variables: Record<string,string> }, idemKey): Promise<ExternalRefData>;
  getPipelineRun(ctx, scope, runId): Promise<{ status: 'queued'|'running'|'succeeded'|'failed'|'cancelled'; url }>;
  listArtifacts?(ctx, scope, runId): Promise<ArtifactMeta[]>; downloadArtifact?(ctx, scope, artifactId): Promise<Readable>;
  listDeployments?(ctx, scope, cursor?): Promise<Page<DeploymentEvent>>;   // environment name, ref, sha, status, time
  reportStatus?(ctx, scope, sha, status): Promise<void>;
}
```

### 4.5 AIProvider (wrapped by the AI Gateway; never called directly by modules)
```ts
interface AIProvider {
  manifest(); testConnection(ctx);
  generateStructured(ctx, req: { model: string; system: string; messages: AIMessage[]; jsonSchema: object;
    maxOutputTokens: number; temperature?: number; cacheHints?: CacheHint[]; timeoutMs: number })
    : Promise<{ json: unknown; raw?: string; usage: Usage; stopReason: string; providerRequestId: string }>;
  generateText?(ctx, req): Promise<{ text: string; usage: Usage; ... }>;
  embed?(ctx, req: { model: string; inputs: string[] }): Promise<{ vectors: number[][]; usage: Usage; dims: number }>;
  runToolLoop?(ctx, req: ToolLoopRequest): AsyncIterable<ToolLoopEvent>;   // sandbox code-gen only
  estimateCost(req, priceTable): Money;
}
// Usage: { inputTokens, outputTokens, cachedInputTokens?, model }
```
If a provider lacks native JSON-schema mode, the adapter emulates it with tool/function calling or with instruction plus validation. The gateway always validates the result ([15 §4](15-ai-agent-architecture.md)).

### 4.6 ObjectStorage
```ts
interface ObjectStorage {
  put(key: StorageKey, body: Readable, meta: { contentType; sha256; size }): Promise<void>;
  get(key): Promise<Readable>; head(key): Promise<ObjectMeta | null>; delete(key): Promise<void>;
  signedUrl(key, op: 'get'|'put', ttlSeconds, constraints?: { maxBytes?; contentType? }): Promise<string>;
  list?(prefix, cursor?): Promise<Page<ObjectMeta>>;
}
```
For `localfs`, the signed URL points to the API's `/files/{token}` endpoint, which streams the file after checking the HMAC token.

### 4.7 WorkflowOrchestrator
```ts
interface WorkflowOrchestrator {
  manifest(); testConnection(ctx);
  dispatch(ctx, target: { templateId: string; endpoint: string }, envelope: MinimalEventEnvelope, signature: string)
    : Promise<{ accepted: boolean; externalExecutionId?: string }>;
  health(ctx): Promise<{ status: 'healthy'|'degraded'|'down'; detail?: string }>;
  deployTemplates?(ctx, templates: WorkflowTemplate[]): Promise<DeployReport>;
  getExecution?(ctx, externalExecutionId): Promise<{ status; startedAt; finishedAt? }>;
}
```
The **Null orchestrator** adapter (essential-only mode) reports `health = down` permanently and `dispatch` → not accepted. As a result, O-F rules always fall back, and O rules queue until their max age, then expire with a clear UI state.

### 4.8 TestEngine and ExecutionBackend
```ts
interface TestEngine {
  manifest(); // engine id, supported versions, artifact types
  discover(workdir: string): Promise<DiscoveredTest[]>;               // runs inside sandbox via entrypoint; returns ids, titles, tags, file
  buildRunSpec(sel: ResolvedSelection, cfg: RunConfig): RunSpec;      // command, env, reporters, shard args, retries, timeouts
  parseResults(files: ResultFiles): CanonicalResults;                 // per test: attempts, status, duration, error, artifacts
  visualCompare?(…): VisualComparison;                                // M09
  resolveImage(lock: LockfileInfo): { image: string; version: string };
}
interface ExecutionBackend {
  manifest();
  provision(spec: SandboxSpec /* image, limits, env, network policy, tokens */): Promise<BackendHandle>;
  start(h): Promise<void>; streamLogs(h): AsyncIterable<LogLine>;
  wait(h, timeoutMs): Promise<{ exitCode: number; oomKilled: boolean }>;
  cancel(h, graceMs): Promise<void>; collect?(h): Promise<void>; teardown(h): Promise<void>;
  reconcile(labelSelector): Promise<BackendHandle[]>;                  // find live handles after restart
}
```

### 4.9 SecretStore, Notifier, IdentityProvider
```ts
interface SecretStore { put(ref, value, meta); get(ref): Promise<SecretValue /* zeroizable */>; rotate(ref, newValue); delete(ref); }
interface Notifier { send(n: { channel; recipients; templateId; params; dedupeKey }): Promise<void>; }
interface IdentityProvider { authenticate(req): Promise<Principal>; startLogin?(); handleCallback?(); groups?(principal): Promise<string[]>; }
```

## 5. Contract testing requirements
- Each family has a **shared contract suite** in `packages/contract-tests/<family>`. It is parameterized by an adapter factory and a fixture mode (`mock` | `recorded` | `live`).
- **Mandatory for merge:** the `mock` and `recorded` modes pass. `live` mode runs only when credentials are present (nightly, optional).
- **Assertions every suite covers:**
  1. **Manifest honesty.** Every declared capability is exercised. An undeclared capability throws `CapabilityMissingError` and never fails silently.
  2. **Canonical mapping.** Provider DTOs map to canonical models. Round-trips (create → get) preserve fields.
  3. **Error normalization.** Simulated 401, 403, 404, 409, 422, 429, 5xx, and timeout map to the right `ProviderError.kind`, and 429 surfaces `retryAfterMs`.
  4. **Pagination and cursors.** Full traversal with no duplicates and no gaps, and the run is resumable from a cursor.
  5. **Idempotency.** `createIssue` with the same idempotency key plus `searchByMarker` recovery never creates duplicates. `createPullRequest` returns the existing PR for the same head branch.
  6. **Safety rules.** Branch prefix enforcement, default-branch refusal, and read-only clone credentials.
  7. **Webhook verification.** Valid passes; invalid, missing, replayed, or oversized deliveries fail; the dedupe key is extracted.
  8. **Redaction.** No secret value appears in logs or errors (the logger spy asserts this).
- **Capability differences** show up as **skipped-with-reason** tests, generated from the manifest. They are never silently skipped. The compatibility matrix in [33](33-provider-compatibility-matrix.md) is generated from these results in CI.
