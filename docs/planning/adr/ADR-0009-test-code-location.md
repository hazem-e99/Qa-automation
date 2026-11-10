# ADR-0009 — Test code location: dedicated QA repository by default
- Status: Accepted · Date: 2026-11-09 · Deciders: QA Automation Architect, Product Manager

## Context
Automated tests, whether generated or maintained, must live in Git and be reviewed through branches and PRs/MRs. At the company, QA engineers may not have write access to application repositories, and the application repositories use different stacks.

## Decision
Each project chooses a **test code location mode**:
1. **`dedicated_repo` (default):** one QA test repository per project (or per product family), on the project's source-control provider. It is bound to the project's `test_repository` role.
2. **`app_repo_folder`:** tests live in a folder of the application repository, `/e2e` by default.

In both modes, QualityOS:
- writes only to `qos/*` branches and opens PRs/MRs. It **never pushes to protected or default branches**.
- generates code that follows the repository's `qualityos.config.json` and `CONVENTIONS.md`.
- maps test cases to code with stable tags in test titles (`@tc:TC-123`), so each automation binding is resolved by tag rather than by file path.

## Alternatives considered
- **App repositories only:** this needs developer permissions and mixes stacks.
- **Tests stored in the QualityOS database:** there would be no code review.

## Consequences
- (+) QA owns the tests, tooling is uniform, and application-repository permissions stay untouched.
- (−) In the default mode, a code change and its test change are in separate PRs. Change-impact analysis links them ([19 WF-B](../19-workflow-specifications.md)).
