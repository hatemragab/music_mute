# 08 — Measure the current full-length GPU processing baseline

**Status:** Local GPU baseline and later isolated real-GPU full job measured;
listening review remains pending.
**Depends on:** 07.
Read [shared rules](EXECUTION-RULES.md) and [measurement protocol](VALIDATION.md).

## Objective and ownership

Produce the reference against which tasks 09–14 will be judged. Own fixture
selection, controlled measurements, baseline artifacts and the bottleneck report.
Do not change inference parameters or implementation during measurement.

Use the task 07 candidate CLI, existing Kim Vocal 2 model and one window per MPS
call. Keep existing output bitrate/recipe for this first baseline; task 12 changes
bitrate separately. Prior installation timings and the screenshot are context,
not a replacement for a new full-length baseline.

## Required work

1. Select a locally available, authorized full-length song and relevant quality
   excerpts. If none is available, request a fixture instead of downloading random
   private/copyrighted audio or inventing results. Hash it and record safe metadata.
2. Verify hardware, power context, runtime identity, GPU availability, candidate
   source identity and absence of competing inference jobs. Report blockers without
   interrupting a production-connected service.
3. Run the bounded cold/warm protocol: separate preload/warm-up from processing and
   collect at least three warm samples. Record every stage, total engine wall time,
   GPU memory where supported, output validity and fixture/output identity.
4. Preserve baseline vocals and lossless intermediate evidence where supported.
   Check boundary and quiet-speech cases; obtain or schedule listening review.
5. Measure normal monitoring versus watch mode on the same GPU workload. Keep
   optional expensive profiling in a separate labeled run; quantify its overhead.
6. If isolated local backend/storage are available, run one full job to separate
   transfer/queue/completion time from engine time. Otherwise label engine-only
   evidence and leave full-job proof pending for task 15.
7. Present stage proportions and variability. Identify whether the next experiment
   should address reloads, inference windows, copies, encoding or transfers using
   evidence, while retaining the agreed task order and recording dependencies.

## Acceptance and handoff

- Reproducible command, all raw samples, comparable median/range, source/runtime
  identity, GPU proof and local artifact locations are recorded.
- One active GPU job, one-window execution and unchanged quality settings are proven.
- No CPU inference benchmark was run; unavailable metrics are labeled unknown.
- Baseline audio and listening status are documented. A pending quality reviewer
  does not become an implicit pass.
- Missing prerequisites produce a blocked measurement report, never guessed values.

Hand task 09 a reviewed bottleneck report and an immutable baseline report/audio
set. Preserve it throughout the remaining tasks; later baselines must be additional
named records, not replacements of the original evidence.

## Local GPU baseline — 2026-09-23

The operator supplied an authorized local song and confirmed the GPU had no
jobs. The source is identified by SHA-256
`c5f3967c3509b1ce949cc2557a3d6d7465bf787befd1a5491162b35d79ef454f`,
2,806,462 bytes, MP3, 44.1 kHz stereo, and 162.284263 decoded seconds
(7,156,736 samples/channel). The source path and media are not tracked in the
repository. The source file was not modified or downsampled. No CPU inference
benchmark was run.

The isolated worktree was at Git base
`507461bf914b4686cffd29ee76360ef8ae228eb2` with uncommitted candidate
changes. The Python engine content digest was
`5cbe74702cda4051e768242f14be5f085bcf66ae1b2f92776fcbebaf3000c13d`;
the built CLI entrypoint digest was
`4a80f2e52f6eb08e29b0d2a9a680ef99ec3aead3d2e873e68ccf62dcf64a1e08`.
The report also records the installed release manifest, model, and recipe
digests. Hardware was Apple M4 Pro on macOS 26.6.2, drawing AC power.
Python 3.13.7, Torch 2.14.0, ONNX Runtime 1.30.0, audio-separator 0.47.0,
and FFmpeg/FFprobe 8.0.3 were reported. MPS fallback was disabled and the
provider reported accelerated dispatch with zero CPU node events. This is
provider evidence, not a per-kernel trace or GPU occupancy measurement.

The installed LaunchAgent was first drained with zero active attempts, then
stopped for the benchmark. It was restarted and its prior `active` local intent
restored afterward. It was loaded/running with child state `ready` and zero
active attempts on the final check; the local status still had the pre-existing
`runtime-identity-unverified` blocker, so service health was not claimed.
Remote claim policy was not changed. No production job, S3 upload, Android, or
iOS flow was run.

Three A/B/A file-benchmark sessions used `kim-vocals-v2-trim`, 320 kbps final
MP3, one MPS window per call, one preload, one recorded cold pass, one warm-up
pass, and three measured passes each. The B session ran the CLI `status
--local --watch --json` concurrently; A sessions used normal monitoring.
Every session used the same source and engine digest. The baseline report and
audio are retained under `$HOME/.codex/musicmute-gpu-baseline-TbPvfE/`:

| Session | Report | Measured warm seconds | Median | Separation median |
| --- | --- | --- | ---: | ---: |
| A, normal | `baseline.json` | 10.3524, 10.3238, 10.2980 | 10.3238 s | 8.6490 s |
| B, watch | `watch.json` | 10.3927, 10.4306, 10.4189 | 10.4189 s | 8.7286 s |
| A, normal repeat | `repeat.json` | 10.3387, 10.4183, 10.3976 | 10.3976 s | 8.7009 s |

The first A session also recorded 4.0113 s preload, 10.8569 s cold run,
10.3459 s warm-up run, and 59.6692 s full benchmark-process wall time for all
five passes and setup/reporting. The warm separation RTF median was 0.0533.
For its measured passes, median stage time was 8.6490 s separation (83.78% of
median pass time), 1.0640 s MP3 encoding (10.31%), 0.2502 s trimming (2.42%),
0.1650 s preparation (1.60%), and 0.0234 s per-job model verification
(0.23%). `modelLoad` returned the already loaded separator in under 0.00005 s.
This makes separation the clear next performance target on this host; a second
model cache or skipped model hash would offer little benefit here.

The watch median was 0.92% slower than the first A median, while the repeated
normal median was 0.71% slower. Comparing B with the average A medians gives
about 0.56%, within the observed run-order variation. The 2-second watch view
emitted 37 JSON status lines totaling 39,817 bytes during B. This sample does
not prove a material watch overhead; a dedicated profiler would require a
separate labeled run. The local runtime diagnostics were not used to claim
the benchmark's own progress in the stopped service.

The report contains MPS allocation samples at run boundaries. Warm measured
passes showed 134,455,552 tensor-allocated bytes and 390,807,552
driver-allocated bytes before and after; the cold boundary differed. These
are not peak allocation, system memory pressure, or occupancy values.

All 30 retained MP3/FLAC artifact files across the three sessions matched the
SHA-256 and byte count in their reports and were owner-private. All 15 MP3s
decoded with FFmpeg. The baseline FLAC measured passes each contained
7,156,736 stereo samples at 44.1 kHz. Against the first measured FLAC, the
other eight measured FLACs had RMS difference about `1.01–1.03e-6`, maximum
sample difference `3.0518e-5`, zero non-finite samples, and zero samples at or
above 0.999 absolute amplitude. The original source was 162.284 s; the trim
recipe produced 159.29 s MP3 results. These checks show repeatability and
valid output, **not** preservation of every quiet word or an approved listening
comparison. Listening review remains pending, and no reference stems exist for
an SDR score.

The report SHA-256 values are: `baseline.json`
`c657d0e4a14bf577e8182adcb06779f941ea2e5d2bc8080fde1255fc26021162`,
`watch.json`
`fc5b28f0424aa5b61ad5f92ce685c85d7d6084982380aa977f263aeb12fd114d`,
and `repeat.json`
`691436b3bf72c17166d96f34b2d24d30e1e38b38949ea66436fc7cd3712dc413`.
Each has the raw run samples, timings, GPU boundary readings, fixture/settings
identity, and saved-audio hashes. Reproduction uses the task 07 command with
the operator's approved source file, its matching SHA-256, `--group-size 1`,
the candidate engine path, three measured runs, and new private report/audio
paths. Do not overwrite these reference reports.

This was **engine-only** proof. Input download, queue, output upload, completion,
and the Android screenshot's full user-visible step were not measured. Task 09
can proceed with the retained warm baseline; tasks 10–14 must compare against
the same source and keep listening review pending until a reviewer approves it.
