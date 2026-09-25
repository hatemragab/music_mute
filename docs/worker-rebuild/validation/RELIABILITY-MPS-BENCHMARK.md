# Reliability candidate MPS benchmark

Executed 2026-09-25 on Apple M4 Pro, macOS 26.6.2. This is a real GPU
candidate-engine benchmark, not packaged release or two-worker acceptance.

## Result

| Measurement | Result |
| --- | --- |
| Input | Project-owned generated stereo WAV, 30 seconds, 44.1 kHz |
| Recipe / provider | kim-vocals-v2 / MPS; CPU fallback disabled |
| Sequence | 1 cold run, 1 warm-up, 3 measured runs |
| Measured run times | 2.044893, 2.025224, 2.053779 seconds |
| Median end-to-end processing time | 2.044893 seconds (14.67x input duration per wall second) |
| Cold processing / preload | 2.590346 / 2.021528 seconds |
| Whole benchmark process | 18.707446 seconds |
| Median separation real-time factor | 0.060141 |
| Output | Five validated 30-second MP3s, 160 kbps, 601382 bytes each |
| GPU dispatch evidence | Accelerated node events: 1; CPU node events: 0 |
| Driver memory after each measured run | 315310080 bytes (300.70 MiB) |
| Tensor memory after each measured run | 67722752 bytes (64.59 MiB) |

Memory was sampled at full-run boundaries and is not peak process/GPU occupancy.
Three short runs cannot establish sustained capacity. No baseline comparison was
run, so these numbers are not evidence of a speedup from reliability changes.
Synthetic audio is not listening-quality acceptance for real vocal/music content.

## Identity and artifacts

- Scope: local-engine-only, candidate-engine.
- Engine digest: b31b9518f2bd6e771a741e937f4e5bb2b66a2d89204231585648c91f11144455
- Installed release manifest: 71ae4f585da0bab0c58545fdb38fae9c70a9c3e21d319b3c1504a1d428c96392
- Fixture digest: 9cfb3c8f68a36ebf5b502cb9a471e03622ca64ed68170227c806837daeb117f4
- Model digest: ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b
- Raw report, saved audio and before/after service snapshots:
  `/Users/hatemragap/.codex/tmp/musicmute-reliability-benchmark-t0mfiv6r/`

The worktree CLI used the worktree engine with the installed private Python/model/
FFmpeg runtime. The candidate was not installed or activated. No capacity receipt
was issued and no second GPU slot was enabled.

## Service safety and restoration

Before work, the installed .43-local.20260925 service was active, healthy and idle.
It was drained without force and stopped before GPU work. The first wrapper attempt
misclassified the stopped status command's expected exit 1 and aborted before
launching the benchmark; its finally block restored service and active intent.
The wrapper was corrected to parse valid status JSON on exit 0 or 1, and readiness
was confirmed before retrying.

The completed benchmark's finally block restored active intent and started the same
installed release. Both the wrapper and an independent status read confirmed:
loaded/running, healthy, modelReady/localReady, child ready, zero readiness blockers.
The wrapper recorded zero active attempts at restoration. Backend claim eligibility
and live S3 job completion were not established by this local status command.

## Packaged candidate: three-minute fixture

A second run used the separate immutable candidate
`0.1.0-mvp.44-reliability.local.20260925.2`, including its own Node, Python,
engine, FFmpeg and FFprobe. The existing verified model cache was reused.
The runner's layout selected the separate bundle; the installed current pointer
was never changed. The raw report calls this `installed-engine` because no
candidate source override was supplied; that label does not mean the candidate
was installed or activated as the service.

| Measurement | Result |
| --- | --- |
| Input | Project-generated stereo WAV, 180 seconds |
| Sequence | 1 cold run, 1 warm-up, 3 measured runs |
| Measured times | 9.775841, 9.184825, 9.128351 seconds |
| Median end-to-end processing | 9.184825 seconds |
| Cold run / warm-up | 15.752907 / 10.025474 seconds |
| Model preload / whole process | 28.856355 / 109.288405 seconds |
| Median separation real-time factor | 0.046392 |
| Output duration | 180 seconds for all five runs |
| GPU dispatch | MPS proven; CPU fallback disabled; 1 accelerated event, 0 CPU events |
| Driver memory after every run | 315310080 bytes (300.70 MiB) |
| Tensor memory after every run | 67722752 bytes (64.59 MiB) |
| Candidate manifest after benchmark | PASS |

Raw evidence, saved output audio, runner and service snapshots:
`/Users/hatemragap/.codex/tmp/musicmute-reliability-package-sm0s7fvm/benchmark/`.
Memory remains boundary sampling, not peak usage. This longer packaged run still
uses synthetic content and one processing slot; it does not authorize two-slot
capacity or establish real-content listening quality, network/S3 throughput,
lease-loss behavior or production canary acceptance. The differing fixture length
and runtime startup conditions prevent treating the earlier timing as a baseline.

## Latest-source packaged rerun: candidate v4

Version `0.1.0-mvp.44-reliability.local.20260925.4` was rebuilt after diagnostic
stream/cursor recovery changes, using the same private dependency inputs. Its
compiled transfer/guardian checks and both candidate/installed manifests passed.
The current full TypeScript suite passed 363 tests with 2 skipped before GPU work.

| Measurement | Result |
| --- | --- |
| Fixture | Same generated 180-second stereo WAV, one slot |
| Measured times | 8.802330, 8.818509, 8.784660 seconds |
| Median / range | 8.802330 / 8.784660-8.818509 seconds |
| Cold / warm-up | 12.998949 / 8.783255 seconds |
| Model preload / whole process | 24.691162 / 94.029391 seconds |
| Median separation real-time factor | 0.044530 |
| Outputs | All five retain 180 seconds |
| GPU dispatch | MPS proven, fallback disabled, 1 accelerated event, 0 CPU events |
| Post-run driver / tensor allocation | 300.70 / 64.59 MiB in all five runs |
| Candidate manifest after benchmark | PASS |

Release manifest digest:
`04b668a174952a0c0a7d71863d6c6085ebfe053f94d281d7735a5a687016d9a8`.
Fixture digest remains
`404342e728e3f2774c9de8bd14e834125c1968bf77955a5a1f66b9ef192b7fe1`.
Raw report, output audio and service snapshots:
`/Users/hatemragap/.codex/tmp/musicmute-reliability-package-sm0s7fvm/benchmark-v4/`.

The runner drained/stopped the original installed worker before GPU work and
restored it in finally. Both the runner and independent local status confirmed
original `.43-local.20260925` active/healthy; runner confirmed loaded/running,
localReady and zero active attempts. No candidate activation occurred.

This is a current-package local-engine benchmark. The 8.80s versus earlier 9.18s
measurement is not a controlled causal speedup claim. Memory is sampled at run
boundaries, not peak. Representative-content listening quality, sustained
concurrent capacity, live backend/S3 and cancellation/lease-loss canary acceptance
remain unproven. The candidate's new diagnostic cursor requires the additive
backend route before deployment; this offline run does not exercise that route.
