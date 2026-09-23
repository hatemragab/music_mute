# 10 — Implement and evaluate GPU window grouping: 1, 2, and 4 windows

**Status:** Local MPS experiment complete; group 2 is a candidate, with listening
review pending. Production remains at group 1. **Depends on:** 09 and baseline/tooling 07–08.
Read [shared rules](EXECUTION-RULES.md) and [measurement protocol](VALIDATION.md).

## Problem and sources

The present path builds one window before inference; changing the `batch_size`
number alone does not group windows. The installed converter previously rejected
batch > 1 by default, and experimental mode has BatchNorm correctness concerns.
Own the real batching implementation, converter compatibility proof and experiment.

Read `worker/engine/musicmute_engine/separator.py`, `provider_adapter.py`,
`pipeline.py`, pinned requirements under `tools/worker-gpu-feasibility/`, the exact
installed `audio_separator` window loop and `onnx2pytorch` converter, and their
licenses/official implementation documentation. Inspect only the relevant pinned
dependency code; do not patch the installed environment in place.

## Required work

1. Verify actual model input/output shapes, dynamic axes, evaluation mode,
   BatchNorm running-stat behavior and converter batch guard on the candidate
   runtime. Prove that one window's output is independent of other batch members.
2. Select the smallest maintainable supported implementation: a narrow owned
   adapter/subclass or reviewed converter/runtime change with tests. Merely enabling
   experimental mode and suppressing warnings is not a correctness proof.
3. Collect 2 or 4 adjacent windows into a real batch, execute one GPU model call,
   and reconstruct them in their original order. Preserve segment size, overlap,
   padding, normalization, channels, precision, hop and overlap-add behavior.
4. Handle a final partial batch without leaking padding into output. Keep grouping
   1 as the reference path. Preserve cancellation responsiveness and bounded memory.
   Report selected/effective group size and progress, not just the requested flag.
5. Extend task 07 capability reporting so 2/4 become supported only when real
   execution exists. Keep one active job/model process per GPU; no concurrent songs.
6. Compare 1, then 2, then 4 using the same full-length song and warm-run protocol.
   Stop larger cases after memory/quality failure. Record failures honestly; an OOM
   fallback must not silently relabel a smaller-group run as a successful group-4 run.

## Validation and acceptance

Test grouping/order, identical windows, different neighboring windows, batch
permutation, quiet audio, partial final batch, boundaries and cancellation. Establish
single-versus-batched PCM tolerance from baseline repeatability. Record all timing,
GPU memory, provider evidence, objective audio checks and listening decisions.

Adopt a group size only if the gain is repeatable and quality is preserved. If the
converter cannot safely support grouping, retain group 1 and document the blocker
for task 14. No arbitrary 15% threshold and no inference-quality compromise.

## Handoff

Provide a 1/2/4 comparison table, chosen default or rejection decision, dependency
changes, runtime identity, retained artifacts and remaining limits for task 11.

## Local experiment — 2026-09-23

The owned MDX subclass now collects adjacent waveform windows into groups of 2
or 4 for benchmark runs. It calls the same pinned `run_model` with the real
batch, then restores the original window order and the installed MDX overlap,
Hann window, padding, and divider behavior. The ungrouped path still delegates
to the installed implementation. The matching-mix path also delegates to the
installed implementation. Grouped runs require MPS; production constructs the
separator with group size 1. The converter's `experimental=True` mode is used
only for grouped candidates; it is not taken as proof by itself.

The installed Kim Vocal 2 ONNX graph has a dynamic batch input/output axis,
27 static-parameter BatchNorm nodes, and no dropout or instance normalization.
All converted BatchNorm modules were in evaluation mode. A direct MPS probe
with four heterogeneous windows returned exactly the same spectral tensors
for individual, 2-window, 4-window, and reordered batches. The grouped full-song
results below additionally prove the STFT, inverse STFT, overlap-add, final
partial batch, and audio export paths. No CPU inference benchmark was run.

The user-provided 162.284 s song and the baseline's `kim-vocals-v2-trim`,
320 kbps recipe were held fixed. Every candidate session used one preload,
one cold pass, one warm-up pass, three measured passes, fallback disabled,
and a stopped installed worker. MPS provider dispatch passed. The worker was
restored to its previous active intent afterward.

| Actual group | Windows / model calls per song | Warm seconds, three runs | Median | Separation median | MPS driver bytes after measured run |
| --- | ---: | --- | ---: | ---: | ---: |
| 1 baseline | 30 / 30 | 10.3524, 10.3238, 10.2980 | 10.3238 s | 8.6490 s | 390,807,552 |
| 2 candidate | 30 / 15 | 9.5399, 9.6261, 9.6106 | 9.6106 s | 7.9418 s | 621,494,272 |
| 4 candidate | 30 / 8, final batch 2 | 9.9940, 9.9928, 10.0023 | 9.9940 s | 8.3268 s | 1,080,770,560–1,095,450,624 |

Group 2 improved median warm engine time by 7.4% versus the first baseline
session, or 7.0% versus the repeated normal baseline median (10.3976 s).
Group 4 improved by only 3.3% versus the first baseline and was 4.0% slower
than group 2. The MPS memory values are run-boundary driver allocations, not
peak use or total unified-memory pressure. The early 4-window spectrogram
probe transiently reached about 5.66 GB of driver allocation; no full-song
peak was captured. This argues against adopting group 4 on this host.

Against the baseline's first measured FLAC, both candidates produced stereo
44.1 kHz FLAC with 7,156,736 samples/channel, no non-finite or clipped samples,
and maximum sample difference 3.0518e-5. Group 2 RMS difference was 1.010e-6;
group 4 was 1.025e-6. Both are within the baseline run-to-run difference
of about 1.01–1.03e-6. These numerical results do not establish absence of
audible seams or preservation of quiet speech; listening review is pending.

The candidate reports and audio remain private under
`$HOME/.codex/musicmute-gpu-baseline-TbPvfE/`: `group2-v2.json`,
`group2-v2-audio/`, `group4.json`, and `group4-audio/`. An initial group-2
run failed because the first adapter revision returned an extra array axis;
that was corrected before the successful measured session and is not included
in the speedup claim. A direct MP3-input diagnostic after that reached audio
export but used an input subtype outside the prepared-WAV production path;
the full benchmark used the real preparation path and succeeded.

The measured recommendation is to retain group 1 as the production default
until a listener checks the retained baseline/group-2 vocal audio, especially
quiet words and transitions. If that passes, group 2 is the candidate to adopt;
group 4 offers less speed for more memory on the tested M4 Pro. The experiment
does not establish the same ranking on other GPU models or song lengths.
