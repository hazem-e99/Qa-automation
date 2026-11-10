# 15 — AI Agent Architecture

> Status: **Planned** · Owner: Senior AI/LLM Engineer · Decision: [ADR-0012](adr/ADR-0012-ai-gateway-bounded-tasks.md)

## 1. Position: bounded tasks, few agents
The brief lists nine candidate agents. We checked each one for what actually **needs** an LLM, and kept the rest as deterministic software.

| Candidate agent | Verdict | Implementation |
|---|---|---|
| Requirements Analyst | **LLM tasks** (bounded) | `requirements.extract`, `requirements.analyze_conflicts`, `requirements.analyze_gaps`, `requirements.embed` |
| Test Planner | **Merged** into Test Case Generator + deterministic coverage engine | Coverage gaps are computed from data. The LLM only proposes cases |
| Test Case Generator | **LLM task** | `tests.suggest`, `tests.suggest_charters`, `tests.suggest_updates`, `tests.improve_wording` |
| Test Code Generator | **Agentic, sandbox only** | `code.generate_test` as a tool loop inside the codegen sandbox; optional Playwright planner/generator |
| Test Execution Coordinator | **Deterministic** (no LLM) | Execution controller + selection resolver + policies |
| Failure Analyst | **Hybrid**: deterministic signals + LLM task | `failures.classify`, `failures.cluster_merge` |
| Defect Triage Agent | **Hybrid** | Duplicate retrieval is deterministic (signatures + vectors), plus `defects.duplicate_judge` and `defects.draft` |
| Test Maintenance Assistant | **Agentic, sandbox only, propose-only** | `code.propose_fix` / Playwright healer in propose mode + diff guard |
| QA Reporting Agent | **LLM task, constrained** | `report.narrative`, with a number-validator |

There is no autonomous loop that crosses module boundaries. Each task is invoked by a use case, its output is validated, and humans approve every authoritative change.

## 2. AI Gateway
```mermaid
flowchart LR
  UC[Use case] -->|runTask(taskId@v, input, scope)| GW
  subgraph GW[AI Gateway]
    direction TB
    C1[Resolve task def<br/>schema · prompt version · model class] --> C2[Policy checks<br/>project AI enabled · consent · task enabled]
    C2 --> C3[Redaction<br/>secrets · PII patterns · custom regex]
    C3 --> C4[Budget pre-check<br/>max cost estimate vs remaining]
    C4 --> C5[Render prompt<br/>system + data blocks (delimited) + schema]
    C5 --> C6[Provider call via AIProvider port<br/>timeout · retry · fallback model]
    C6 --> C7[Validate output<br/>JSON schema + semantic validators]
    C7 -->|invalid| C8[Repair attempt ×1<br/>with validation errors]
    C8 --> C7
    C7 -->|valid| C9[Persist ai_execution + ledger<br/>store redacted I/O refs]
  end
  GW --> UC
```

**Task definition** (code, in `packages/prompts/<task>/`):
```ts
defineTask({
  id: 'tests.suggest', version: 3,
  modelClass: 'standard',            // fast | standard | deep → resolved per project config
  inputSchema: TestsSuggestInput,     // Zod
  outputSchema: TestsSuggestOutput,   // Zod → JSON Schema for provider
  prompt: 'prompts/tests.suggest/v3.md', // template with {{data:...}} slots
  semanticValidators: [refsExist, acCoverageMapped, noExploitContent],
  maxInputTokens: 12000, maxOutputTokens: 4000, timeoutMs: 90000,
  redaction: 'default+project', costClass: 'medium',
  evalDataset: 'evals/tests.suggest/v3.jsonl',
});
```

## 3. Task catalog
| Task | Input | Output (schema essentials) | Model class | Human gate | Typical cost driver |
|---|---|---|---|---|---|
| `requirements.extract@1` | blocks chunk, context, glossary | `candidates[{kind, text, quote, sourceBlockIds[], confidence}]`, `inferredAcceptanceCriteria[]` | standard | Review + approve | Document size |
| `requirements.analyze_conflicts@1` | pair of requirement versions | `{conflict, type, explanation, quotes[2], confidence}` | standard | Resolve finding | Cluster pairs |
| `requirements.analyze_gaps@1` | requirement version + context | `findings[{type: gap|ambiguity, checklistItem, explanation, suggestedQuestion, inferredAC?}]` | fast | Resolve | Per requirement |
| `requirements.embed` / `tests.embed` / `defects.embed` | text | vector | embedding | — | Low |
| `tests.suggest@1` | approved requirement versions + AC + conventions + existing test titles | `cases[{title, type, priority, preconditions, testData, steps[{action, data, expected}], expected, coversAC[], requirementVersionIds[], rationale, assumptions[]}]` | standard | Accept/edit/reject (+ approval policy) | Requirements × depth |
| `tests.suggest_charters@1` | requirements + risk areas | `charters[{mission, areas, risks, timeboxMin}]` | fast | Accept | Low |
| `tests.suggest_updates@1` | old vs new requirement version + linked test versions | `updates[{testCaseId, changeType: edit|retire|new, proposedVersion, reason}]` | standard | Accept | Impacted tests |
| `tests.improve_wording@1` | test case draft | improved fields + change list | fast | User applies | Low |
| `code.generate_test@1` (agentic) | test case versions, conventions, repo map, app URL | patch (unified diff), assertion map, notes | deep (tools) | PR review | Exploration steps |
| `code.propose_fix@1` (agentic) | failing test, trace digest, diff since last pass | patch + explanation | deep (tools) | Guard + PR review | Steps |
| `failures.classify@1` | evidence digest (signals, error, stack top, trace actions tail, console errors, failed requests, history) | `{classification, confidence, rationale, evidenceRefs[], suggestedSeverity?, rootCauseHypothesis?}` | fast | Approval for defect creation | Failures per run |
| `failures.cluster_merge@1` | cluster signatures + samples | merge groups | fast | — | Low |
| `defects.duplicate_judge@1` | candidate draft + top-3 defects | `{duplicateOf?, score, reasons[]}` | fast | Human confirms | Low |
| `defects.draft@1` | cluster, test case version, evidence digest, environment | `{title, summary, stepsToReproduce[], expected, actual, environment, evidence[], severity, severityRationale, priority}` | standard | Approval policy | Per cluster |
| `defects.draft_from_manual@1` | execution step results | same as above | fast | Approval policy | Low |
| `sessions.summarize@1` | session notes | summary, risks, follow-ups | fast | — | Low |
| `report.narrative@1` | KPI JSON | narrative paragraphs + `numbersUsed[]` | fast | Number validator | Low |

## 4. Output validation and hallucination handling
1. **Schema validation** against the JSON Schema. One repair retry that includes the validation errors. After that, the task fails `invalid_output`.
2. **Semantic validators** (deterministic):
   - *Reference existence*: every ID points to an existing entity in scope.
   - *Quote grounding*: quotes are substrings of the cited source after normalization.
   - *Number grounding* (`report.narrative`): every number appears in the input.
   - *AC coverage mapping*: covered AC belong to the referenced requirement version.
   - *Safety filters*: no exploit payloads, no off-scope URLs. URLs must be on the project's environment allowlist.
3. **Confidence is metadata, not truth.** The UI shows it, and policies never auto-approve because of high confidence (exception: an explicit low-risk policy for internal S4 drafts, off by default).
4. **Abstention is allowed.** Schemas include `insufficientInformation: boolean` and `questions[]`, so the model can decline instead of guessing.

## 5. Prompt versioning
- Prompts live in Git: `packages/prompts/<task>/v<N>.md` plus a schema file. The `prompt_versions` table records the content hash and git SHA at deploy.
- Each `ai_execution` stores the task version and prompt version. A new prompt version **must** pass its eval set at or above the current version's score before it becomes default (CI gate). Rollback is a config flip.
- Per-project overrides are limited to *additional instructions* in a delimited block (e.g. house style). Core instructions can't be replaced per project.

## 6. Agentic code generation (sandbox only)
```mermaid
sequenceDiagram
  participant M7 as M07 use case
  participant EC as execution-controller
  participant SB as codegen sandbox (no write token)
  participant AI as AI provider (tools)
  participant PUB as publisher container (scoped write token)
  participant GIT as Repo provider
  M7->>EC: codegen.run(job)
  EC->>SB: start (test repo via proxied archive; egress limited to the env hosts + QualityOS AI-gateway proxy)
  loop bounded steps (max 40 tool calls, max tokens budget)
    SB->>AI: messages + tools(read_file, write_file, list_dir, run_cmd[allowlist], browser_snapshot[allowlisted hosts])
    AI-->>SB: tool calls
    SB->>SB: execute tool in workspace
  end
  SB->>SB: lint, typecheck, run new tests ×3
  SB-->>EC: patch + reports (upload token)
  EC->>EC: diff guard (AST) on patch
  alt guard ok
    EC->>PUB: apply patch → push qos/gen/* → open PR (draft if failing)
    PUB->>GIT: push + PR
  else guard blocked
    EC-->>M7: guard_blocked report
  end
```

- **Where the AI call happens.** The AI key never enters the sandbox. Sandbox tool loops call the **AI Gateway through an internal proxy endpoint**, authenticated with the per-run token. The gateway adds the provider key, redaction, and budget control. So the sandbox's egress allowlist includes only the QualityOS gateway proxy and the environment hosts.
- **Tools.**
  - `read_file` and `write_file`, confined to the workspace.
  - `run_cmd`, with an allowlist: `npm ci`, `npx playwright test <files>`, `npx tsc --noEmit`, `npx eslint`.
  - `browser_snapshot`, which captures the accessibility tree and a screenshot of allowlisted URLs.
  - There is no general shell and no network tool.
- **Playwright Test Agents.** When the project enables them, the planner and generator agent definitions run in the same sandbox under the same tool restrictions. The healer runs only in `propose` mode for M07-FR-10.

## 7. Model-provider abstraction and fallback
- Projects map **model classes** (fast, standard, deep, embedding) to concrete models on their AI connection.
- **Fallback chain per class** (optional): e.g. a deep model, then a standard model on timeout or 5xx. Every fallback is recorded.
- **Retry policy:** 429 or 5xx gets exponential backoff with max 3 attempts, honoring `retry-after`. A timeout gets 1 retry, then fallback. A 400 or validation error is not retried, except the repair step.
- **Circuit breaker per provider connection:** after 5 consecutive failures in 1 minute, the breaker opens for 60 s. Tasks fail fast with `provider_unavailable`, and the UI degrades: manual paths stay available.

## 8. Guardrails: prompt injection, data, and tool safety
| Threat | Control |
|---|---|
| Injection via documents, work items, issue comments, DOM text, repo files | System prompt states data blocks are untrusted. Data goes in `<data source="…">` delimited blocks with escaping. **No task with untrusted input has side-effect tools** (except the sandbox codegen, which is isolated and whose output passes the diff guard and human PR review). Output schemas leave no room for free-form actions |
| Data exfiltration through generated URLs/markdown | Output URL validator allowlists environment hosts and QualityOS. Markdown is rendered with link rewriting and no auto-loading images from external hosts |
| Sensitive data to provider | Redaction pipeline (regex packs: tokens and keys (GitHub, Azure, AWS, JWT), emails, phone numbers, national ID patterns configurable) + project redaction rules + `do_not_send` fields. Per-project AI consent flag |
| Over-spending | Budget pre-check, per-task max tokens, per-job step caps |
| Unsafe security-test generation | Safety validator + prompt policy: test *ideas* against own non-prod environments; no exploit code, no third-party targets (M05-FR-07) |
| Model output treated as authority | Approval Policy Engine; confidence never sufficient alone |
| Stored prompts with secrets | Inputs stored **after** redaction. Bodies retained 30 days, metadata longer |

## 9. Token usage, cost, and budgets
- Every call is recorded in `ai_usage_ledger`: input, output, and cached tokens, model, `cost_micros` (from `price_tables` effective at call time), task, project, user, and correlation ID.
- **Pre-call estimate:** input tokens are counted locally (tokenizer approximation, ±10%) plus `maxOutputTokens` × the output price. The call is rejected if the estimate exceeds the remaining budget (BR-M14-4).
- **Cost levers:**
  - provider prompt caching for stable system prompts and conventions
  - batching per requirement group
  - incremental analysis on changed items only
  - fast models for classification
  - caching of embeddings by content hash
- **Projected pilot usage** (to be measured, AS-17):
  - about 200 requirements analysed once, plus deltas
  - about 300 test suggestions
  - about 30 failure classifications per night
  - about 10 code-generation jobs per week

  The USD 50/month default budget is a ceiling, not a forecast. The real figures come out of the pilot.

## 10. Evaluation
| Task | Dataset (initial) | Metrics | Acceptance threshold to ship |
|---|---|---|---|
| requirements.extract | 30-doc corpus with gold candidates | precision, recall, grounding failures | per [14 §7](14-requirements-engine.md); grounding failures 0 after validation |
| analyze_conflicts | 60 labelled pairs (30 conflicts) | precision, recall | precision ≥ 0.80, recall ≥ 0.60 |
| analyze_gaps | 40 requirements with expert gap lists | precision (useful findings) | ≥ 0.70 judged useful |
| tests.suggest | 40 requirements + expert reference suites | AC coverage %, incorrect expected-result rate, duplicate rate, reviewer acceptance (pilot) | AC coverage ≥ 0.90; incorrect expected ≤ 0.05; acceptance ≥ 0.60 in pilot |
| failures.classify | 150 labelled failures | accuracy, product_defect precision, confusion matrix | product_defect precision ≥ 0.85; overall accuracy ≥ 0.80 |
| defects.duplicate_judge | 80 pairs | precision, recall | precision ≥ 0.90 |
| defects.draft | 40 clusters, rubric scoring by 2 reviewers | rubric score (reproducibility, accuracy, completeness) | ≥ 4/5 average |
| code.generate_test | 20 test cases with reference impls on demo app | compile rate, pass rate ×3, assertion coverage, locator lint | compile ≥ 0.95; pass ≥ 0.80; assertion coverage 1.0 (guard) |
| report.narrative | 20 KPI payloads | number-grounding violations | 0 after validator |

- Eval runs: on every prompt or model change (CI job with recorded fixtures for deterministic scoring, live calls in a nightly optional job) and weekly during the pilot with live data. Results are stored in `docs/evals/` (future) and in the AI quality dashboard (M12).
- **Feedback loop:** human dispositions (rejections with reasons, classification overrides, duplicate unlinks) are captured and turned into dataset candidates after review. They are never trained on automatically.

## 11. Failure modes and responses
| Failure mode | Detection | Response |
|---|---|---|
| Plausible but wrong expected results | Grounding validator, reviewer rejection reasons | Prompt iteration; stronger AC mapping requirement |
| Over-flagging conflicts | Dismissal rate > 50% | Raise thresholds; restrict pairs |
| Misclassifying product bugs as flaky | Override stats | Deterministic flaky signal must agree (history) before `flaky` classification |
| Provider outage | Circuit breaker | Manual paths; queued AI tasks resume |
| Cost spike | Budget alerts at 80% | Hard stop at 100% |
| Injection attempt in document | Output validators; anomaly flags (e.g., output contains instructions) | Discard output; finding logged; security event |
