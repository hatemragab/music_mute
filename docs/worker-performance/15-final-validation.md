# 15 — Validate the complete flow, compare results, and document proven improvements

**Status:** Local implementation and applicable validation complete. Listening
review and installed-candidate/production proof remain pending. **Depends on:**
01–14 with outcomes/evidence recorded.
Read [shared rules](EXECUTION-RULES.md) and all of [validation](VALIDATION.md).

## Objective and scope

Verify the integrated local worker, CLI and backend contract flow, then
produce an operator guide and evidence-backed before/after report. Own integration
gaps caused by these tasks and final documentation. This task does not authorize
production deployment, packaging publication, Git commits, or merging.

## Required work

1. Review each task's outcome and all changed contracts. Ensure generated protocol
   copies, validators, recipe digests, CLI help, tests and affected consumers agree.
   Remove task-owned dead experiment paths and unnecessary compatibility code.
   Confirm no migrations/backfills, unrelated edits or secrets entered the diff.
2. Run focused remaining tests and changed-component gates. Run the worker verify
   script and applicable backend checks after inspecting environment scope.
   Fix regressions caused by this work. Record unavailable prerequisites explicitly.
3. Exercise an isolated local flow: task-owned fixture upload to local test storage,
   claim, worker input, GPU separation, 192 kbps encoding, output publication,
   backend result readiness and locally verifiable decoding. Use candidate code,
   local destinations and fresh task-owned data. No mobile application is involved.
4. Demonstrate the operator workflow: watch a job, investigate it by ID, inspect
   errors, explain a failure, view performance, export a job bundle and compare GPU
   benchmark reports. Check non-TTY/JSON output, SIGINT, offline backend and stale
   progress. Start/resume/log maintenance must preserve active work and warm state.
5. Run the failure matrix with controlled local fault injection. Verify cancellation,
   retry ownership, uncertain completion, child recovery, storage retention and
   disk failure reporting. Ensure the system explains blocked admission accurately.
6. Re-run the same bounded full-length GPU protocol on the final selected setup.
   Compare both original task 08 and intermediate baselines; separate inference,
   warm-up, encoding, transfer and total-job improvements. Include all samples,
   memory, diagnostics overhead and decoded-audio/listening outcomes.
7. Write the final operating guide: actual commands/examples, readiness definitions,
   error catalogue, retention/recovery behavior, benchmark reproduction, selected
   grouping and limits, output settings, and deferred mobile contract implications.

## Acceptance criteria

- All executed tasks have honest status, evidence and a clear handoff outcome.
- At least one reproducible comparison explains what improved or why a candidate
  was rejected; no invented percentage or promised “Removing music” duration.
- GPU-only inference benchmark, one job/GPU, source preservation, 192 kbps final
  output and bounded sanitized history requirements are met or explicitly blocked.
- Quality approval includes listening evidence; otherwise mark adoption/quality
  pending and preserve the proven default. Build success is not audio approval.
- Local integration, mocked tests, GPU execution and listening evidence are
  labeled separately. Mobile UI/device proof is outside scope; no production
  readiness claim is inferred from local tests.
- Final diff contains only intended code/tests/docs once implementation is authorized;
  no commit/push/deploy or destructive cleanup has occurred without a new request.

## Final handoff to the user

Provide a concise outcome summary, changed components, before/after table, exact
validation commands and results, report/artifact links, remaining limitations, and
any concrete decision still needed. Leave the branch available for review; do not
merge or remove the worktree.

## Local completion report — 2026-09-23

Implementation is on branch `hatem/worker-gpu-processing-performance` in the
separate worktree. The main checkout, Android, iOS, production API, production
S3 and installed worker release were not updated. The installed worker was
temporarily stopped for exclusive GPU tests and restored to active, running,
child-ready state with zero attempts; its full Doctor/release-manifest check
passed afterward. Test-generated `librosa` cache directories that appeared in
the immutable installed release during one isolated run were identified as
additions only and moved to a private quarantine, not deleted. The final real
GPU test routes Numba cache to its isolated fixture directory.

### What the measurements support

All measurements use the authorized 162.284-second, 44.1 kHz stereo song,
identified by SHA-256
`c5f3967c3509b1ce949cc2557a3d6d7465bf787befd1a5491162b35d79ef454f`.
The source bytes and preparation settings were unchanged. Each GPU benchmark
had one active job/slot, a cold pass, one warm-up and three measured warm
passes, with MPS dispatch evidence and zero CPU fallback node events.

| Configuration | Warm engine samples | Median | Separation median | MPS driver allocation at warm boundary | Decision |
| --- | --- | ---: | ---: | ---: | --- |
| Original one-window, 320 kbps | 10.3524, 10.3238, 10.2980 s | 10.3238 s | 8.6490 s | 390,807,552 B | Reference |
| Two windows, 320 kbps | 9.5399, 9.6261, 9.6106 s | 9.6106 s | 7.9418 s | about 621 MB | Candidate; listening pending |
| Four windows, 320 kbps | 9.9940, 9.9928, 10.0023 s | 9.9940 s | 8.3268 s | about 1.08–1.10 GB | Not preferred |
| Final default one-window, 192 kbps | 10.3490, 10.3513, 10.4061 s | 10.3513 s | 8.6688 s | 390,807,552 B | Selected default |

Two-window grouping was about 7.4% faster than the first reference median,
with greater MPS memory use. Four windows was slower than two. Comparing the
final 192 kbps one-window run to the original one-window run shows no material
engine speedup; the small difference sits within repeat-run variation. The
192 kbps file was 3,824,369 bytes against 6,373,920 bytes at 320 kbps, exactly
40.0% smaller in this fixture. Identical separated PCM took about 1.00 seconds
to encode at either bitrate. The smaller output may shorten real uploads, but
that network benefit has not been measured.

The final benchmark report is private at
`$HOME/.codex/musicmute-gpu-baseline-TbPvfE/final-192-group1.json`, with its
MP3/FLAC audio and per-run hashes in `final-192-group1-audio/`. The original
`baseline.json`, normal repeat `repeat.json`, `group2-v2.json` and `group4.json`
remain separate. Independent lossless comparison of the first measured final
FLAC to the original reference found 7,156,736 samples/channel at 44.1 kHz,
RMS difference `1.0494e-6`, maximum `3.0518e-5`, zero non-finite and zero
clipped samples. This supports separation repeatability, not audible quality
approval. The two-window comparison was also within baseline-repeat sample
variation, but quiet speech and boundary listening are still pending. The
decoded 192-versus-320 MP3 difference likewise needs listening review.

### Real GPU through the isolated local API

`WORKER_INTEGRATION_REAL_GPU=true node --test
test/worker-fleet.integration.mjs` ran the candidate Python MPS child on the
same song through isolated local MongoDB, Redis, NestJS API and task-owned
versioned object storage. It exercised upload, authoritative claim, source
download/checksum, actual MPS separation, 192 kbps encoding, output upload,
completion, public progress and result download/FFprobe. A current worker's
window percentage was observed through public job detail while processing.
The local result was MP3, 192,000 bit/s, 44.1 kHz stereo, 159.290 seconds and
3,824,369 bytes. This is not production S3 or an Android playback test.

In the last isolated run, claim-to-ready flow measured **11.031 seconds** with
the model already preloaded. Its worker timing event contained separation
9.230 s, preparation 0.175 s, trim 0.244 s, MP3 encoding 1.072 s, local
input download 9.46 ms, local result upload 23.48 ms and completion ack
18.30 ms. The **25.53-second test process** also included isolated service
startup, Python model preload and other fixture work; it is not job latency.
Production queue delay, WAN/S3 transfer time and phone upload time remain
unmeasured. The normal simulated-child local integration test also passed
claim/completion, progress replay and wrong-worker rejection, cancellation,
lease recovery and readback.

### CLI and automated gates

The [operator guide](OPERATOR-GUIDE.md) records the commands and recovery
boundaries. Against the existing installed release, the candidate CLI's quick
Doctor, `errors`, `explain` and `perf` JSON commands ran; `status --local
--watch --json` emitted parseable schema-v2 observations and exited 0 on
SIGINT. The candidate `job` query correctly returned exit 2 and an explicit
no-local-history warning for a synthetic unknown ID. A focused diagnostics
bundle was created with the expected allowlisted sections and missing-evidence
manifest. The candidate `status --local` currently reports
`runtime-identity-unverified` when reading the older installed service's
runtime-status schema; that mixed-version observation is not a deployed
candidate failure. The global installed release's Doctor and status were
healthy after restoration. Synthetic and fault-injected worker tests cover
actual candidate status, timeline, errors, retention and bundle behavior.

- Worker `pnpm run verify` passed with the qualified packaged Python interpreter:
  protocol check, format, lint, typecheck, 261 TypeScript tests, 49 Python tests
  and build. The system Python lacked the engine dependencies, so it was not
  used for the final gate.
- Backend `pnpm run verify` passed: format, lint, typecheck, tracked-secret scan,
  814 unit tests, 140 E2E tests and build.
- Backend `pnpm run test:worker:integration` passed with isolated local storage.
  The explicit real-GPU variant passed three times during integration work; the
  final run logged the 11.031-second claim-to-ready interval above.
- `git diff --check` passed. No migrations, Android/iOS edits, generated media,
  credentials or environment files were added to the worktree diff.

The remaining decision is a listening review of the retained one-window versus
two-window vocals, especially quiet words, boundaries and music leakage, plus
192 kbps versus 320 kbps sibilance. Until then the live default remains one
window per MPS call. Direct owner-source model weights and one GPU slot per
job remain enforced. CoreML and alternative models were not qualified, so no
runtime/model change is recommended. The candidate has not been packaged,
installed, deployed, committed, pushed or merged.
