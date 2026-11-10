# M07 — Automated Test Generation

> Status: **Planned** · Phase: P9 (P6 delivers bindings for hand-written tests) · Owner: QA Automation Architect + AI Engineer · Related: [ADR-0009](../adr/ADR-0009-test-code-location.md), [15 §6](../15-ai-agent-architecture.md), [17](../17-test-execution-engine.md)

## 1. Purpose & responsibilities
This module turns approved test cases into maintainable executable tests. It always delivers them as a **reviewed Git change**, i.e. a branch plus a PR/MR. It also covers:
- binding test cases to code
- understanding the repository's conventions
- proposing maintenance changes when tests break

It must never hide real bugs, never weaken assertions silently, and never modify baselines without a review.

## 2. Roles
- `qa_engineer` with the automation flag, and `qa_lead`, can request generation.
- Reviewers in the Git provider review and merge (QualityOS never merges).
- `developer` can view generation jobs.

## 3. Features
| ID | Feature |
|---|---|
| M07-FR-01 | Test repository onboarding: detect or scaffold-propose `qualityos.config.json` (engine, test dir, base URL env var, tag format, fixtures path, page-object dir, lint command) and `CONVENTIONS.md`; scaffold proposal itself delivered as a PR |
| M07-FR-02 | Generation request: select test cases (approved, `candidate`) → generation job in sandbox → PR `qos/gen/{jobKey}` with summary |
| M07-FR-03 | Generation strategy: (1) **deterministic skeleton** from structured steps (test title with `@tc:` tag, steps as `test.step`, and every expected result mapped to a real assertion, never a placeholder); (2) **AI code task** fills locators/actions by inspecting the app via Playwright in the sandbox (accessibility-tree snapshots) and existing page objects; optionally uses Playwright Test **planner/generator** agents |
| M07-FR-04 | Locator policy: prefer `getByRole`/`getByLabel`/`getByTestId`; forbid brittle XPath/CSS nth-child unless justified in comment; reuse page objects |
| M07-FR-05 | Fixtures and data isolation: per-test data via fixtures/factories or API seeding hooks defined in conventions; no shared mutable state; unique data suffixes per run |
| M07-FR-06 | Verification before PR: in the sandbox, run lint/typecheck and the generated tests against the chosen environment N=3 times; PR description reports results (pass/fail/flaky) — failing generated tests are still allowed in PR **marked draft** with explanation (may indicate real bug or unclear step) |
| M07-FR-07 | Assertion preservation: every expected result of the test case maps to ≥1 assertion; mapping table included in PR description; reviewer checklist |
| M07-FR-08 | Automation bindings: on merge to default branch (detected via polling/webhook), discover tests by tag `@tc:{KEY}` → create/activate `automation_bindings` → test case status `automated` |
| M07-FR-09 | Binding health: binding resolving to 0 tests (renamed/removed) → `automation_broken` + notification; multiple tests per case allowed (data variants) |
| M07-FR-10 | Maintenance proposals: when a test fails with classification `test_defect` (e.g., locator not found after UI change), task `code.propose_fix` (or Playwright **healer** in propose mode) produces a PR; **forbidden changes**: removing/weakening assertions, changing expected values, updating visual baselines, adding `test.skip`/`fixme` — enforced by diff guard |
| M07-FR-11 | Diff guard: static analysis of generated diffs (AST-based) rejects PRs that remove `expect` calls, change literal expected values mapped to approved test cases, or touch baseline files; violations require explicit human-authored change |
| M07-FR-12 | Generation job tracking: status, logs (sanitized), cost, sandbox artifacts (trace of exploration), PR link and PR state sync |
| M07-FR-13 | Hand-written tests support: any test with `@tc:` tag binds the same way — automation does not require AI |

## 4. User journeys
J5. A maintenance journey: a nightly failure is classified `test_defect`. A fix proposal PR appears, with a diff guard report showing no assertion changes. The engineer reviews and merges it, and the next run passes.

## 5. UI screens
- `S-GEN-01` Generation request dialog (selected cases, target repository/branch base, environment for verification, engine options, cost estimate)
- `S-GEN-02` Generation jobs list and detail (timeline, logs, verification results, assertion map, PR status)
- `S-GEN-03` Bindings view per test case (file path, test title, last result, binding health)
- `S-GEN-04` Repository onboarding wizard (conventions detection results)

## 6. Domain entities
`code_generation_jobs`, `code_changes` (branch, PR ExternalRef, diff summary, guard report), `automation_bindings` (test_case_id, repo binding, selector: tag + optional file/title, status, first_seen_commit, last_seen_commit), `repo_conventions` (parsed config snapshot per commit).

## 7. API endpoints
| Method | Path |
|---|---|
| POST | `/api/v1/projects/{key}/codegen/jobs` (testCaseVersionIds, environmentId, options) → operation |
| GET | `/api/v1/projects/{key}/codegen/jobs?status` · `/{id}` · `/{id}/logs` |
| POST | `/api/v1/projects/{key}/codegen/jobs/{id}:cancel` |
| POST | `/api/v1/projects/{key}/test-repo:onboard` (proposal PR) |
| GET | `/api/v1/projects/{key}/bindings?status` · POST `/bindings:rediscover` |
| POST | `/api/v1/projects/{key}/codegen/fix-proposals` (executionId) |

## 8. Business rules
- BR-M07-1: QualityOS writes **only** to branches with the prefix `qos/`. It refuses to push if the target branch is the default branch or is protected (checked through `repo.branch.protection.read` when available, and always refused for the default branch).
- BR-M07-2: It never merges PRs and never approves its own PRs.
- BR-M07-3: A PR is opened only if lint and typecheck pass. If they fail, the job ends `failed` with logs, and no PR is created.
- BR-M07-4: The diff guard is mandatory (FR-11). A guard violation blocks PR creation. The job ends `guard_blocked` with a report.
- BR-M07-5: Generated tests run against non-production environments only.
- BR-M07-6: A binding is activated only from code on the default branch, so tests running in nightly regressions are reviewed code.
- BR-M07-7: Sandbox exploration may only navigate to hosts on the environment allowlist ([17 §6](../17-test-execution-engine.md)).

## 9. Permissions
`codegen.request`, `codegen.cancel`, `binding.rediscover`, `test_repo.onboard`. The repository write permission comes from the connection's token, not from the user, so the policy engine records which user requested each write.

## 10. Provider dependencies
- `RepositoryProvider`:
  - `repo.read`
  - `repo.branch.create`
  - `repo.commit.push`
  - `repo.pr.create`
  - `repo.pr.read`
  - optional: `repo.branch.protection.read`, `repo.checks.read`
- Degradation: without `repo.pr.create` (e.g. Local Git), a patch file is offered and the branch is pushed only if `repo.commit.push` exists.
- `TestEngine`: `engine.playwright`
- `ExecutionBackend`: local Docker (codegen profile)
- AI Gateway tasks: `code.generate_test`, `code.propose_fix`

## 11. Events & workflow integration
- Emits:
  - `codegen.job.completed`
  - `codegen.pr.opened`
  - `codegen.pr.merged`
  - `binding.activated`
  - `binding.broken`
- Class E jobs:
  - `codegen.run` (execution controller, codegen sandbox profile)
  - `bindings.discover` (on default-branch change)
- Class O workflows:
  - "PR opened → notify reviewer channel"
  - "binding broken → notify owner"

## 12. Security requirements
- The codegen sandbox is the same hardened sandbox as for runs, but its credentials are a **branch-scoped write token**:
  - GitHub fine-grained PAT limited to the test repository, `contents:write` and `pull_requests:write`
  - GitHub App installation token where available
  - GitLab project access token with the Developer role (P13)
- The token is injected as an environment variable only for the final push step, through a separate short-lived "publisher" container. The exploration/generation container has **no write token**: it produces a patch, and the publisher applies and pushes it.
- AI agent tools inside the sandbox are restricted to: read repo files, write the working copy, run allowed commands (`npm ci`, `npx playwright test`, lint), and browse the allowlisted hosts. There is no general shell network access.
- Prompt-injection defense: repository content and app DOM text are untrusted, and the guard plus the human PR review are the final controls.

## 13. Failure scenarios & error handling
| Scenario | Behavior |
|---|---|
| Environment unreachable during exploration | Job fails fast with `environment_unreachable`; no PR |
| AI produces non-compiling code | 2 repair iterations with compiler output; then `failed` with logs |
| Generated test fails consistently | PR opened as **draft** labelled `qos:needs-investigation` with failure evidence; possible product defect suggested to M10 (not auto-filed) |
| Push rejected (branch protection, token scope) | `failed_publish` with provider message; no retry without config change |
| PR closed unmerged | Job `abandoned`; test cases revert to `candidate` |

## 14. Edge cases
- One test case maps to several data-driven tests: each binding carries a `variant` label.
- A merged PR whose tests are later renamed without the tag: the binding is marked broken and a rediscovery suggestion appears.
- Repository conventions change: they are re-parsed per commit, and generation always uses the conventions at the base commit.

## 15. Acceptance criteria
| ID | Criterion |
|---|---|
| M07-AC-01 | Generating automation for 3 approved test cases against the demo app creates a `qos/gen/*` branch and PR. Each test title contains `@tc:` tags, and the PR description contains an assertion map that covers every expected result. |
| M07-AC-02 | QualityOS refuses any push to the default branch, verified by an adapter contract test and an integration test. |
| M07-AC-03 | A fix proposal whose diff removes an `expect` call is blocked by the diff guard, and no PR is created. |
| M07-AC-04 | After the PR merges to the default branch (mock provider), bindings activate within one poll interval, and the test cases show `automated`. |
| M07-AC-05 | Renaming a bound test to drop its tag marks the binding `automation_broken` on the next discovery and notifies the owner. |
| M07-AC-06 | The generation/exploration container has no repository write credential. Inspecting its environment and filesystem during a test shows no token. |
| M07-AC-07 | A hand-written test with an `@tc:` tag binds without any AI involvement. |

## 16. Implementation tasks
- P6: T-P6-14 (binding discovery by tag for hand-written tests).
- P9:
  - T-P9-01 conventions config + onboarding PR
  - T-P9-02 deterministic skeleton generator
  - T-P9-03 codegen sandbox profile + publisher container
  - T-P9-04 `code.generate_test` task (AI Gateway + sandbox tool loop)
  - T-P9-05 Playwright planner/generator integration (optional mode)
  - T-P9-06 verification runs ×3 + report
  - T-P9-07 diff guard (AST)
  - T-P9-08 PR creation + state sync
  - T-P9-09 jobs UI
  - T-P9-10 fix proposals + healer propose mode
  - T-P9-11 binding health + notifications
  - T-P9-12 degradation for providers without PRs
  - T-P9-13 codegen eval set
  - T-P9-14 cost tracking per job

## 17. Testing requirements
- Diff guard unit tests with an adversarial diff corpus.
- E2E against the demo app (a small seeded web app in the repo's `fixtures/demo-app`).
- An eval set of 20 test cases with reference implementations, scored on compile rate, pass rate, locator quality lint, and assertion coverage.
- Contract tests for the PR capability across adapters.

## 18. Dependencies & technical risks
Depends on M05, M08 (sandbox), M03 (repository adapters), and the AI Gateway.

| Risk | Mitigation |
|---|---|
| Generated tests are flaky or brittle | Verification ×3, locator lint, conventions, and human review |
| The agent wanders and costs too much | Step and token budget per job; cost estimate before the job starts |
