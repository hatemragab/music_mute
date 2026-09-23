# 06 — Add CLI performance reports and job-specific diagnostic bundles

**Status:** Implemented locally; final worker gates and CLI/bundle walkthrough
passed. **Depends on:** 02–05.
Read [shared rules](EXECUTION-RULES.md) and [validation](VALIDATION.md).

## Objective and scope

Turn recorded timings into useful comparisons and export enough evidence to debug
one job. Own performance queries, report rendering, and focused bundle exports.
This task does not tune the model or claim speed improvements.

Read `worker/src/platform/macos/user-cli.ts`, `diagnostic-bundle.ts`,
`operational-logs.ts`, `runtime/worker-runtime.ts`, and task 02/03 timing/history
interfaces. Extend the existing bundle format instead of creating an unrelated
support archive mechanism.

## Required work

1. Add `perf --last <count>` with bounded selection and optional time/recipe filters.
   Show download, preparation, separation, encoding, upload, and completion timings,
   decoded audio duration, separation RTF, output size, and cold/warm classification.
2. Group comparable observations by model/recipe/runtime/hardware and relevant
   audio settings. Separate successful, failed, cancelled, and retried attempts.
   Report count, median and range. Do not compare a short cold job against a long
   warm job or average incomparable ratios into a misleading speedup.
3. Explain the dominant measured stage and missing timing coverage. Label overlap,
   network waiting, and engine-only scope. A long broad “Removing music” duration
   must not automatically be attributed to GPU inference.
4. Add `diagnostics --job <id>` and a bounded time-range option. Include related
   attempts, errors, stage timings, runtime/model identity, local/remote freshness,
   diagnostic coverage and relevant health checks. Preserve general bundles too.
5. Sanitize a documented allowlist at export; omit source media, local media paths,
   tokens, signed URLs, credentials and environment values. Output bundles privately
   with size limits, a manifest, and explicit missing sections.
6. Provide stable JSON reports with units, scope, schema version and sample counts.
   Use the same query/aggregation code for terminal output and bundles.

## Validation and acceptance

Use a known synthetic history to verify exact durations, median/count, RTF,
cohort separation, retries, and missing data. Test incomplete/expired history and
malformed events. Inspect a generated synthetic bundle for required files and
forbidden fields. Exercise write failure, output collision and export size bounds.
Prove reports and bundles are read-only with respect to service lifecycle and jobs.

## Handoff

Provide sample reports and a bundle manifest using synthetic data, query schema,
privacy tests, and the fields task 07/08 will use for baseline comparison.

## Local implementation and measurement scope

`musicmute-worker perf --last 20 --since 1d --recipe kim-vocals-v2 --json`
reads at most 10,000 retained local events and selects the last 1–100 attempts.
The JSON report is schema version 1, scope `local-worker-history`, with explicit
millisecond, second, byte and ratio units. Success events now carry decoded
input duration, output bytes, model/recipe identity, provider, logical GPU slot,
group size, output bitrate, and child stage timings. The worker also measures
input download, output publication, and completion acknowledgement with a
monotonic clock. Input-grant waiting and backend queue time remain unmeasured.
All live jobs begin with a preloaded model; cold-start benchmark timing is a
separate task 07 observation.

The report separates successful, failed, stopped, active, and unknown attempts.
The `retried` count comes from observed backend attempt numbers above one. It
does not imply every earlier attempt was local. A successful sample reports
`separationRtf = separationMs / (decodedInputSeconds * 1000)`. Missing timing
fields stay missing; they are never set to zero. `dominantMeasuredStage` is
only the largest recorded operation, not proof of total wall-time or GPU
occupancy. The report lists missing stages and missing coverage explicitly.

Comparable cohorts require identical provider, logical GPU slot, runtime
incarnation, recipe/model digests, bitrate, group size, preloaded state, and a
five-second decoded-duration bucket. A cohort shows sample count, median and
min/max per measured stage and RTF. No speedup is inferred across cohorts or
from different songs. The logical slot is not a hardware model. Task 07/08
must record actual GPU and runtime identity for repeatable benchmark comparison.

Synthetic sample for a 180-second decoded input, with 90 seconds of measured
separation: `separationRtf: 0.5`, `stageMs.separation: 90000`, and
`dominantMeasuredStage: separation`. This is an arithmetic example, not a
measured speed claim.

`musicmute-worker diagnostics --job <id> --since 1d` extends the existing
private ZIP exporter. A focused manifest lists `status.json`, `doctor.json`,
`job.json`, `job-performance.json`, and `job-errors.json`, plus missing
sections. The export uses the same investigation/performance query functions
as the CLI. The general bundle keeps recent allowlisted events and config
field names; raw stderr was removed from exported files. Status and Doctor
are projected onto fixed allowlists, omitting file paths and unrecognized
fields. Existing targets are rejected. Staging and final ZIP sizes are capped
at 8 MiB, with owner-only files and cleanup on failure.

Focused tests cover synthetic stage medians and RTF, bitrate cohort separation,
retry/failed separation, missing timing coverage, job-bundle privacy, output
collision, and oversized export cleanup. Full worker validation remains in
task 15.
