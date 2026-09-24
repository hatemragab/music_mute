# Validation and evidence requirements

## Benchmarks

Use task 07 tooling, then task 08 baseline, before changing inference behavior.
Benchmark the candidate worktree runtime, not a globally installed release merely
because its CLI has the same name. Record code SHA plus dirty-tree description or
content digest, model hash, recipe digest, runtime/dependency versions, device,
OS, window group size, overlap, segment size, output settings, and fixture hash.
Do not claim the baseline commit identifies uncommitted candidate code.

Use one selected full-length song consistently across configurations. Record its
decoded duration, channels, sample rate, and sample count without exposing a
private filename. Add quality excerpts containing quiet speech, strong music,
sibilants, silence, vocals at window boundaries, and a partial final window.

Initial bounded protocol: one recorded cold run and at least three warm measured
runs per configuration in the same loaded process where appropriate. Report every
sample, median, min/max and variation. Three samples are a starting point; if a
small gain overlaps run variation, classify it as inconclusive or repeat a bounded
additional set. Alternate baseline/candidate order to reduce thermal/cache bias.
Record power/thermal context where observable and other GPU activity. Stop on OOM,
non-finite output, unsupported GPU execution, or quality failure.

Measure model load and warm-up separately; then input transfer, verification,
decode/preparation, separation, encoding, output transfer and completion. Use a
monotonic clock for durations. GPU operations are asynchronous: synchronize at
measurement boundaries where supported, and describe whether a number includes
transfer/synchronization overhead. Do not add synchronization to every production
window just to make timing easier. Distinguish local-engine time from full-job time.

Definitions:

- Separation RTF = separation seconds / decoded input seconds; lower is faster.
- Audio throughput = decoded input seconds / separation seconds; higher is faster.
- Speedup = baseline comparable median / candidate comparable median.
- Job latency is elapsed wall time for one job. It is not concurrent-job throughput.
- Peak GPU allocation, driver allocation, system memory pressure, and process RSS
  are different observations; report only supported measurements and label them.

Prove the selected GPU provider and model residency/dispatch with available
runtime evidence. Residency is not an occupancy percentage or proof that every
operator executed on GPU. Identify unexpected inference fallback; do not benchmark
CPU inference as an alternative. Mocks validate logic but cannot establish speed.

## Audio quality

For grouping/buffer experiments keep all audio settings constant. The direct
MP3 path does not retain a lossless intermediate; decode both final MP3 files
to PCM for comparison, align samples, check
duration/sample count, channels, finite values, clipping, gain, and boundary
discontinuities. Define numerical tolerances from the measured one-window
repeatability; do not loosen them merely to accept a candidate.

Retain local baseline/candidate vocals with opaque names. Conduct a level-matched,
preferably blind listening comparison of quiet words, starts/ends, boundaries,
music leakage, sibilance, and reverb. Record reviewer, cases, observations, and
decision. A correlation score or valid decode is not listening approval. If a
reviewer is unavailable, report “listening review pending” and retain the proven
default. No fake SDR/separation-quality score without suitable reference stems.

Test 192 kbps separately from inference grouping so codec differences do not hide
an inference regression. Compare alternative models under the same fixture and
quality protocol, acknowledging outputs will not be sample-identical.

## Tests and commands

Read current package scripts before running. Start with focused tests, then run
required changed-component gates once. These are future validation commands, not
commands run while preparing this documentation.

From `worker/`:

```sh
pnpm exec vitest run tests/macos-user-cli.spec.ts
pnpm run typecheck
pnpm run lint
pnpm run protocol:check
pnpm run test:engine
pnpm run build
```

Select the matching Vitest/Python suites for each task. Inspect the engine test
runner to use the accepted interpreter. Keep actual GPU performance runs explicit
and separate from mocked unit tests. At integration completion run `pnpm run verify`
when its configured prerequisites are available. Format only touched files during
implementation; avoid a repo-wide formatting mutation.

From `backend/`, when changed: focused `pnpm exec vitest run <test-file>`,
`pnpm run typecheck`, `pnpm run lint`, and `pnpm run build`, plus relevant isolated
integration tests after inspecting their destinations. **Do not run
`test:worker:integration:s3` as a local default: its current script loads
`.env.production`.** Keep live/cloud tests out of this package's authorization.

Do not run Android/iOS builds or tests for this package. Check dashboard/Windows
consumers if worker/backend contract edits affect them. Record mobile contract
implications without changing mobile code. Do not claim cross-platform runtime
proof from Mac unit tests.

## Failure and diagnostics matrix

Exercise startup not ready, stale heartbeat, backend unreachable, backend paused,
local drain, cancellation, child crash, known GPU allocation failure, generic
timeout, input failure, output upload failure, uncertain completion, spool quota,
disk write failure, corrupt/truncated record, interrupted rotation, and CLI SIGINT.
Use deterministic fault injection in task-owned local tests. Generic timeout must
not be labeled OOM. Missing history must be marked missing/expired, not success.

Measure monitoring overhead on the same GPU workload: normal diagnostics versus
watch view and optional tracing. Report latency variation, memory, event volume,
disk growth, and dropped/coalesced samples. Do not run an unrelated CPU benchmark.

## Evidence report template

For each task record:

1. Task ID, status, code/runtime identity and date.
2. Behavior changed and affected contracts/files.
3. Exact commands, exit results, environment scope, and raw artifact locations.
4. Before/after measurements with all samples and method, or “not applicable”.
5. Automated audio checks and listening outcome, or why not required; mobile UI
   and device evidence remain outside this package.
6. Known limitations, inconclusive results, and next-task handoff.

Keep reports under this package or a linked docs validation directory; keep large
raw artifacts/media outside tracked docs. A recommended optimization must have a
repeatable speed benefit, acceptable memory use, and completed quality review.
