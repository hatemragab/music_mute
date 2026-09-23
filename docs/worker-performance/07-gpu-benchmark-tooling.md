# 07 — Upgrade GPU benchmarks with repeated runs, saved audio, and baseline comparison

**Status:** Implemented and exercised on the full-length authorized MPS song.
**Depends on:** 01–06.
Read [shared rules](EXECUTION-RULES.md) and the complete [measurement protocol](VALIDATION.md).

## Problem and sources

The existing file benchmark already validates MPS and reports cold/warm timing,
but limits total iterations to one or two and deletes output audio. Extend it so
later optimization decisions have repeatable timing and quality evidence.

Read `worker/src/platform/macos/user-benchmark.ts`, `user-cli.ts`,
`worker/engine/musicmute_engine/qualification.py`, `pipeline.py`, `separator.py`,
`worker/src/enrollment/report-builder.ts`, and their tests. Inspect immutable
release resolution so candidate code is actually exercised without modifying the
installed release in place.

## Required work

1. Support explicit warm-up and bounded measured-repeat counts, at least three
   warm runs, and a separately labeled cold run. Keep repeated warm runs in the
   same model process. Show incremental stage/run progress and cancellation.
2. Add explicit report/audio output options, private directories, baseline-report
   comparison, and preservation of failed-run diagnostics. Existing defaults may
   still clean temporary data; retaining media must be intentional.
3. Capture source hash/decoded metadata, candidate code identity, model/recipe hash,
   GPU/OS/runtime versions, group size and relevant parameters, every timing sample,
   supported GPU memory observations and provider proof. Include telemetry scope.
4. Validate baseline compatibility before producing speedup numbers. Report
   differences and refuse misleading comparisons. Produce a compact summary plus
   structured raw results; do not replace all samples with one average.
5. Provide a documented candidate-runtime path or task-owned local release build
   route. Do not patch installed site-packages or overwrite a signed release.
6. Keep one active job per GPU. Require an idle, exclusive local test environment;
   preserve drain/stop checks. Any convenience lifecycle orchestration must be
   explicit, bounded and restore prior local intent without overriding backend
   restrictions. An interrupted run must not leave an orphan child.
7. Add a group-size parameter/schema hook but **reject unsupported 2/4 grouping**
   until task 10 implements the real loop. Do not relabel `--workers 2` as batching.
   Never add CPU benchmarking or silent provider fallback.

## Validation and acceptance

Test parsing bounds, same-process repeats, candidate identity, partial results,
interruption, output permissions, incompatible baselines, missing metrics, and
GPU-unavailable refusal. Use mocks for orchestration tests and a small explicit GPU
smoke run only when an isolated GPU context is available. This smoke is not the
full-length baseline or a claimed speedup. Document the actual supported syntax.

## Handoff

Give task 08 a reproducible command sequence, report schema, candidate runtime
resolution, output locations, and recovery instructions. Provide a supported
group-size-one baseline before implementing experimental grouping.

## Local implementation and task 08 handoff

The `benchmark-file` CLI now invokes `musicmute_engine.benchmark_file`, which
reuses the qualified Kim pipeline and model process. The first full pass is
recorded as cold; optional additional warm-up passes and 3–10 measured passes
follow in the same process. Each run has a role, raw timing sample, stage
timings, decoded duration/sample count, output digest/size, and supported MPS
allocation samples. The report contains median/min/max for measured runs.
The runner synchronizes MPS only at full-run boundaries. Allocations from
`torch.mps.current_allocated_memory` and `driver_allocated_memory` are boundary
samples, not peak memory or GPU occupancy ([PyTorch MPS allocation docs](https://docs.pytorch.org/docs/main/generated/torch.mps.driver_allocated_memory.html)).

The command requires the existing `draining` local intent and a completely
unloaded LaunchAgent. It does not start, stop, resume, or change backend
policy. Ctrl-C and timeout terminate the benchmark process group. A failed
run saves a sanitized partial report under `state/benchmark-failures/`;
explicitly saved audio may be partial. The model source remains direct-owner
only. `PYTORCH_ENABLE_MPS_FALLBACK=0` is set for the benchmark and `--provider`
accepts only `mps`. The MPS proof covers model residency and qualified
accelerated execution; it is not a per-kernel trace.

Candidate code comes from `--candidate-engine <worktree>/worker/engine`. The
installed Python dependency runtime imports that source through `PYTHONPATH`;
installed site-packages and the signed release are left alone. `engineDigest`
hashes the candidate Python package contents. `releaseManifestDigest` names
the installed dependency/runtime release and must not be presented as the
candidate code SHA. Reports are schema version 2 with `scope:
local-engine-only`. They include fixture/model/recipe digests, GPU model when
reported by `system_profiler`, OS/runtime versions, audio settings, every
sample, MPS evidence, and timing/memory scope. `--report` and
`--save-audio-dir` require new paths inside the current user's home, with
owner-only files. MP3 and lossless FLAC vocals are saved only when requested.
Each saved file is represented by an opaque relative name, byte count, and
SHA-256 in the report, so the later listening and PCM comparison can verify
that it is reviewing the retained run's audio.

Example sequence after selecting an approved full-length fixture path:

```sh
pnpm --dir /absolute/worktree/worker build
node /absolute/worktree/worker/dist/src/cli/main.js drain
node /absolute/worktree/worker/dist/src/cli/main.js status --watch
node /absolute/worktree/worker/dist/src/cli/main.js stop
node /absolute/worktree/worker/dist/src/cli/main.js benchmark-file --input /absolute/song.mp3 \
  --recipe kim-vocals-v2-trim \
  --candidate-engine /absolute/worktree/worker/engine \
  --warmup-runs 1 --runs 3 --group-size 1 \
  --report /absolute/home/benchmarks/baseline.json \
  --save-audio-dir /absolute/home/benchmarks/baseline-audio --json
```

The report and audio parent directory must already exist; the report file
and audio directory must not. Resume local claims after the test only according
to the operator's previous intent and current backend authority. For a
candidate run, use the same song and settings with new output paths, then add
`--baseline-report /absolute/home/benchmarks/baseline.json`. A speedup number
appears only when source, model, recipe, settings, GPU model, OS, dependency
runtime, and decoded duration match. Candidate engine digests may differ by
design. Unknown GPU model prevents a numerical comparison. Group size 2/4
still rejects until task 10 implements actual window grouping.

Focused proof: Python tests use a fake separator to show one preload and five
passes in one process, preserved private MP3/FLAC, and partial failure report;
TypeScript tests cover run counts, cold/warm roles, median, compatibility
gates, saved-report baseline round trips, and subprocess interruption. The
saved CLI report is normalized, so baseline import validates and reconstructs
its run fields before recalculating the summary; it does not trust a stored
median. `--help` was read against the worktree module. No real GPU timing or
quality result has been claimed yet.
