# 09 — Optimize model loading, warm-up, and reuse between jobs

**Status:** Warm reuse verified; diagnostic instrumentation implemented locally.
**Depends on:** 08; uses lifecycle fixes from 01.
Read [shared rules](EXECUTION-RULES.md) and [measurement protocol](VALIDATION.md).

## Objective and sources

Keep a valid model warm across sequential jobs and remove proven redundant startup
work. The pipeline already has preload/reuse behavior; first establish what it
actually does. Do not add a second cache or daemon simply because warm reuse was
recommended in discussion.

Read `worker/engine/musicmute_engine/pipeline.py`, `separator.py`, `child.py`,
`provider_adapter.py`, `artifacts.py`, and `worker/src/runtime/worker-runtime.ts`,
`worker/src/agent/child-process.ts`, runtime adapter, and task 08 evidence.

## Required work

1. Trace model construction, verified loading, conversion, GPU placement, warm-up,
   reuse keys, child recovery, cancellation and normal job cleanup. Instrument
   load/reload reason and model incarnation through task 02 diagnostics.
2. Establish reuse identity from model/provider/device and inference-affecting
   settings. Output encoding or trim settings should not require reloading the
   same network unless the implementation demonstrates a genuine dependency.
3. Remove unnecessary reconstruction/warm-up only where evidence shows it occurs.
   Keep verification at appropriate trust boundaries and invalidate reuse correctly
   after model/runtime changes, unhealthy child state or incompatible settings.
4. Maintain one loaded model/active job per GPU. Avoid duplicate preparation on
   simultaneous start/recovery paths. Bound recovery attempts and expose failures.
5. Preserve readiness until actual warm-up succeeds. Keep cancellation and backend
   pause/drain authority correct. A completed or cancelled job must not corrupt
   reusable buffers/state for the following job.

## Validation and acceptance

Use meaningful lifecycle tests for sequential jobs, recipe changes, cancellation,
recoverable/fatal failures, restart and invalidation. Count model constructions and
warm-ups with test doubles. Then run the identical full-length GPU fixture using
task 07 tooling and compare with 08: cold time, repeated warm separation, memory
after sequential jobs, and decoded audio/listening as applicable.

If reuse is already correct and no avoidable reload exists, record that evidence
and keep the implementation; do not manufacture a rewrite. Diagnostics that explain
legitimate loads remain useful. Do not claim a speedup from construction-count tests.

## Local result — 2026-09-23

The Python child creates one `RuntimePipeline`, preloads it before the `ready`
response, and retains that object through sequential requests. The pipeline
keys its separator by provider, verified model path, and DirectML device ID;
a different key fails instead of silently replacing a warm model. The
separator constructor loads/converts/places the Kim model and warms it once.
Recipe trim and encoding settings do not enter this reuse key. Each job still
calls `verified_cached_model`, which checks size and hashes the model file at
the trust boundary before `_get_separator` returns the existing separator.

The task 08 full-length MPS baseline exercised one preload and five passes of
the same source in one process. Preload took 4.0113 s. Cold pass took 10.8569 s;
the three measured warm passes took 10.3524, 10.3238, and 10.2980 s. Warm
`modelLoad` was under 0.00005 s per pass, and model verification was about
0.0234 s (0.23% of median pass time). Warm MPS tensor and driver allocation
boundary samples were stable at 134,455,552 and 390,807,552 bytes. All measured
FLAC passes retained identical sample count and only the task 08 repeat-scale
PCM difference. The Python fake benchmark test counted one preload and five
process calls; pipeline tests count one separator construction across preload
and recipe changes. These observations do not support a model reload or
model-hash optimization for this host, so no second cache, skipped verification,
or inference change was introduced. There is no task 09 speedup claim.

Worker diagnostics now emit `model-ready` only after a child reports ready,
with its child incarnation and explicit load reason: initial start, recovery
after an interrupted attempt, slot recovery, or return from an idle remote
benchmark. `attempt-started` records the same child incarnation with its
preloaded state and model digest. The private diagnostic spool allowlists the
opaque incarnation and reason; `job <id>` exposes the incarnation for each
retained local attempt. No model path or filename is recorded. A child restart
uses a fresh process wrapper, and backend pause/drain authority is unchanged.

Focused Node tests cover initial load, interrupted-attempt recovery, remote
benchmark reload, diagnostic sanitization, and job investigation identity.
The existing Python tests cover sequential recipe changes, stable separator
construction, and benchmark passes. A second GPU run after this telemetry-only
Node edit would execute the same Python engine digest as task 08 and is not
treated as a new optimization result. Listening review remains pending.

## Handoff

Record retained model lifetime, invalidation rules, changes or no-change conclusion,
measured results and quality status. Provide task 10 the validated warm baseline and
the original task 08 comparison, preserving both identities.
