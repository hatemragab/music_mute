# Checkpoint evidence report

Use one report per branch, with a subsection for each checkpoint. Do not prefill success.

## Identity

- Assigned branch:
- Parent/accepted collection SHA:
- Actual tested commit:
- Pull request base: `codex/worker-rebuild`
- Test run ID and environment:
- Date/time with timezone:
- Agent/operator:

## Scope

Describe implemented work and exact changed areas. Separate completed code from supplied documentation, fixture tests from real GPU/service tests, and source-derived behavior from new choices.

## Checkpoint results

| ID | Status: PASS / FAIL / NOT_RUN / BLOCKED | Evidence path / command | Actual observation | Remaining input |
| --- | --- | --- | --- | --- |
| <ID> | NOT_RUN | <fill after execution> | <no invented result> | <if applicable> |

## Commands actually executed

Record commands, exit codes and sanitized result summaries. Never include credentials, full presigned URLs, raw private audio or environment dumps. A command that exists in a task but was not run belongs under pending tests, not here.

## Hardware and runtime evidence

When relevant: actual host OS/build/architecture, GPU, memory, service identity/context, driver, provider/package/model/recipe/fixture versions and digests. State how accelerated inference was established. Provider presence alone is not enough.

## Failure and recovery evidence

Attempt IDs and transitions, lease expiry/reassignment, stale-result rejection, corruption/unauthorized access tests, logs replay, cleanup, update candidate/rollback results. Use synthetic/test-only identifiers where practical.

## Compatibility and safety

Preserved client contracts/history/usage/deletion; `.local.env` ignored/untracked; tests isolated; no secrets/artifacts in Git; no production changes; no `main`/clean-slate mutation. Record any approved deviations and their scope.

## Pending and limitations

List unavailable hardware/access/manual approvals. Unknown is not passed. State exactly what blocks making the PR ready for review versus independent work that is complete.

## Handoff

- Ready for review or draft:
- Maintainer approval required:
- Next branch permitted only after previous merge and explicit continuation:
- Artifacts/evidence attached:
