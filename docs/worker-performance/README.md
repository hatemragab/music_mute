# Worker performance and CLI investigation task package

> **New follow-up plan (2026-09-23):** [160 kbps mobile upload and worker output](../audio-transfer-160/README.md)
> covers Android, iOS, backend size protection and variable worker MP3 output up
> to 160 kbps. It supersedes this package's 192 kbps/source-preservation decision
> for that future work and includes mobile changes. Its six tasks are planning
> only; the implementation status and measurements below describe the earlier work.

**Status: local implementation and applicable automated validation complete.**
All 15 tasks have implementation or an evidence-backed research outcome in this
worktree. [Task 15](15-final-validation.md) records the integrated result and
remaining limits. [The operator guide](OPERATOR-GUIDE.md) shows the candidate
CLI workflow. Listening approval for two-window grouping and 192 kbps output,
installed-candidate proof and production network measurements remain pending.

Prepared on 2026-09-23 from the worker performance discussion and source review of
commit `507461bf914b4686cffd29ee76360ef8ae228eb2`. Source observations describe that
baseline; the executing agent must check the current source before changing it.
The user authorized local implementation after reviewing the package. The mobile
scope correction remains binding: no Android or iOS code changes.

## Objective

Make the CLI explain what the worker is doing, why a job is slow or failing, and
how to investigate it. Use those tools to measure and improve GPU processing,
especially the long “Removing music” stage shown in the Android screenshot, while
preserving vocals. Android and iOS implementation is outside this package.

## Start here

1. Read [execution rules and accepted decisions](EXECUTION-RULES.md).
2. Read [source map and current findings](SOURCE-MAP.md).
3. Execute the numbered tasks in order only after implementation is authorized.
4. Use the [measurement and evidence requirements](VALIDATION.md) for benchmarks,
   quality comparisons, and completion reports.

Each task contains its own purpose, dependencies, source pointers, implementation
requirements, acceptance criteria, and handoff evidence. Shared documents are
part of every task. Task titles below are links to the complete briefs.

## Execution order

Execution status is recorded in each numbered brief. The previous numbered task is the execution
gate unless its brief explicitly permits an evidence-only outcome. Dependencies
listed inside each brief explain technical coupling; they do not authorize
parallel edits to shared files.

| Order | Task                                                                                                           | Required result                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 01    | [Fix CLI lifecycle commands to preserve active jobs and warm models](01-cli-lifecycle.md)                      | Start/resume avoid unnecessary restarts; explicit restart drains safely. |
| 02    | [Define diagnostic events, error codes, progress, and timing contracts](02-diagnostic-contracts.md)            | One validated and sanitized vocabulary across worker components.         |
| 03    | [Implement seven-day diagnostic retention with bounded disk usage](03-diagnostic-retention.md)                 | Bounded history, predictable rotation, visible write failures.           |
| 04    | [Build accurate CLI readiness checks and live status monitoring](04-readiness-and-live-status.md)              | Live state, progress, freshness, and claim-block reasons.                |
| 05    | [Build job timelines, error investigation, and actionable Doctor reports](05-job-and-error-investigation.md)   | Investigate an individual job and get evidence-based next steps.         |
| 06    | [Add CLI performance reports and job-specific diagnostic bundles](06-performance-reports.md)                   | Comparable timing summaries and useful private support bundles.          |
| 07    | [Upgrade GPU benchmarks with repeated runs, saved audio, and baseline comparison](07-gpu-benchmark-tooling.md) | Reproducible GPU measurements and preserved quality evidence.            |
| 08    | [Measure the current full-length GPU processing baseline](08-gpu-baseline.md)                                  | Reviewed baseline with repeated warm runs and clear scope.               |
| 09    | [Optimize model loading, warm-up, and reuse between jobs](09-model-reuse.md)                                   | Avoid unnecessary reloads; measure cold and warm behavior.               |
| 10    | [Implement and evaluate GPU window grouping: 1, 2, and 4 windows](10-window-grouping.md)                       | Correct grouping, measured speed/memory, preserved vocals.               |
| 11    | [Reduce audio buffer allocations and CPU–GPU transfer overhead](11-buffer-and-transfer-overhead.md)            | Profile-guided changes with bounded memory and quality proof.            |
| 12    | [Encode final voice MP3 at 192 kbps while preserving source quality](12-output-mp3-192.md)                     | Consistent contracts and smaller final files.                            |
| 13    | [Improve worker input transfer and expose real processing progress](13-worker-input-and-progress.md)           | Measured transfer stages and trustworthy worker progress.                |
| 14    | [Evaluate alternative GPU models and runtimes for speed and vocal quality](14-model-and-runtime-evaluation.md) | Evidence-based comparison; no forced replacement of the baseline.        |
| 15    | [Validate the complete flow, compare results, and document proven improvements](15-final-validation.md)        | Integrated local evidence, operator guide, and honest limitations.       |

## Mapping to the original seven suggestions

| Original suggestion                                  | Tasks that deliver it  |
| ---------------------------------------------------- | ---------------------- |
| Keep the model loaded and warm                       | 01, 09, 15             |
| One GPU job with controlled 1/2/4-window experiments | 07, 08, 10, 15         |
| Measure all parts of “Removing music”                | 02, 04, 05, 06, 08, 13 |
| Reduce allocations and CPU–GPU transfers             | 11                     |
| Final voice MP3 at 192 kbps                          | 12                     |
| Meaningful progress data for a later Android update  | 02, 04, 13             |
| Evaluate alternative GPU models/runtimes             | 14                     |

The added CLI suggestions are covered by tasks 01–07: lifecycle correctness,
readiness, fast local status, live views, job/error investigation, useful Doctor
output, retained history, efficient log following, safe log maintenance, focused
diagnostic bundles, and reproducible benchmark comparisons.

## Review points

- Seven days of sanitized history is accepted. **100 MiB is the implemented
  default** for the aggregate managed history budget, configurable and subject
  to review.
  A size cap can shorten the available history; expose that clearly.
- The command forms in the briefs were finalized in the candidate CLI. See the
  operator guide for current parser/help/JSON behavior.
- GPU comparisons use the same approved full-length song. The task 08 source is
  identified by hash in its brief. Listening review and challenging excerpt
  selection remain pending.
- No task changes, builds, or tests Android or iOS code. Updating their progress
  screens and upload preparation is a separate future project. Worker/backend
  progress may be exposed locally, but these tasks make no mobile UI claim.

## Suggested instruction for a future AI worker

> Read this README, EXECUTION-RULES.md, SOURCE-MAP.md, VALIDATION.md, and the
> assigned numbered task. Work in the named worktree and branch. Confirm that
> implementation has been authorized, then complete only the assigned scope and
> its required validation. This is local development: update incompatible code
> and contracts together; do not create migrations or compatibility layers.
> Preserve other contributors' changes. Report changed files, actual checks,
> evidence paths, remaining limitations, and the next task's prerequisites.
> Do not commit, push, publish, deploy, or use production services without an
> explicit request. Never claim a benchmark or quality gate passed without evidence.
