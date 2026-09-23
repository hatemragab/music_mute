# 11 — Reduce audio buffer allocations and CPU–GPU transfer overhead

**Status:** Profiled; no copy optimization retained because the measured bound
is immaterial beside MPS model time. **Depends on:** 10's measured selection or
documented grouping rejection. Read [shared rules](EXECUTION-RULES.md) and
[validation](VALIDATION.md).

## Objective and ownership

Reduce measured host preparation, allocation, device transfer and synchronization
overhead around GPU inference. Own only bottlenecks demonstrated by profiling.
This is a GPU pipeline experiment; it does not authorize CPU inference benchmarking.

Read `worker/engine/musicmute_engine/separator.py`, `pipeline.py`, `media.py`,
`limits.py`, the actual pinned separator/window/STFT implementation and task 10's
results. Understand which transforms already run on CPU/GPU before proposing moves.

## Required work

1. Profile the selected configuration with one job and the same full-length fixture.
   Identify repeated tensor construction, dtype/layout conversion, allocation,
   host/device copies, output synchronization and reconstruction costs. Mark
   profiling overhead separately from normal-run timing.
2. Address one measured issue at a time: reuse fixed-size buffers, minimize redundant
   conversions, transfer a grouped output instead of individual windows when safe,
   or reuse bounded reconstruction storage. Avoid retaining an entire long song on
   GPU just to eliminate copies.
3. Use correct inference/evaluation semantics and supported MPS operations. Do not
   introduce reduced precision, different overlap/segment settings, lower sample
   rates, or a new model as an unreported part of this optimization.
4. Define buffer ownership and lifetime so cancellation, failure, padding and the
   next job cannot read stale audio. Keep memory bounded by configured work size,
   not unbounded job history. Preserve output order and actual progress.
5. Keep GPU synchronization at required ownership/measurement boundaries; avoid
   per-window synchronization for a status display. Compare with the selected task
   10 configuration and with original task 08 separately.

## Validation and acceptance

Test reuse with different consecutive inputs, partial batches, cancellation and
failure/retry. Check stale-buffer contamination, non-finite values, sample counts,
boundaries and memory after repeated jobs. Run the GPU comparison and quality
protocol. Keep only changes with repeatable benefit and acceptable memory; revert
task-owned unsuccessful experiments without touching others' changes.

An evidence-backed no-change outcome is acceptable if transfers are not material
or a proposed change worsens latency/memory. Do not optimize allocation counts
alone while total job latency regresses.

## Handoff

Record the profile, specific cost reduced, before/after timings, memory, quality
results, retained implementation and rejected experiments. Hand task 12 an unchanged
inference-quality baseline so the encoding change can be measured independently.

## Local MPS profile — 2026-09-23

The group-2 full-song run from task 10 measured median warm separation time of
7.9418 s. Its per-song path uses 30 windows in 15 model calls. The installed
MDX implementation creates a new CPU tensor from each NumPy batch and later
calls `torch.tensor` on the MPS result tensor before inverse STFT. These are
the two obvious redundant copies around inference.

With the worker drained and stopped, the pinned M4 Pro runtime loaded the same
Kim Vocal 2 model on MPS with CPU fallback disabled. A separate labeled
microprofile used a deterministic 2-window float32 input. Every sample had
MPS synchronization at its boundaries; 12 repetitions were measured. This
deliberately measures operation cost, with synchronization overhead, rather
than claiming representative whole-song latency:

| Operation | Median | Min–max |
| --- | ---: | ---: |
| `torch.tensor(numpy_batch).to(mps)` | 0.3092 ms | 0.2976–0.5528 ms |
| `torch.from_numpy(numpy_batch).to(mps)` | 0.2149 ms | 0.1957–0.3130 ms |
| `torch.tensor(mps_prediction).to(mps)` | 0.3717 ms | 0.3611–0.5296 ms |
| Reuse MPS prediction tensor directly | 0.0004 ms | 0.0003–0.0008 ms |
| Full pinned `run_model` on 2 windows | 415.2914 ms | 413.9563–423.9688 ms |

The two copy substitutions have an optimistic combined bound near 0.47 ms
per call, or about 7 ms for the full song's 15 group-2 calls. That is under
0.1% of the 9.61 s median warm engine pass. The full `run_model` includes
STFT, inference, inverse STFT and MPS-to-host output; the profile does not
attribute all 415 ms to the model graph alone. Driver allocation after the
microprofile was about 2.78 GB and is not peak occupancy.

No copy change was retained. Reimplementing pinned upstream STFT/inverse STFT
to remove a sub-millisecond copy would add maintenance and correctness risk
without a measurable user-facing gain at this song length. The same task-10
group-2 audio, quality result and production group-1 default carry into task
12. No CPU inference benchmark or full-song post-change speedup is claimed.
The installed worker was restarted and its prior active intent restored after
the profile.
