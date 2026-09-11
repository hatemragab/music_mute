# Z440 reliability and performance implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement and review these tasks. Do not commit, push, deploy, or modify live Windows settings from this checkout.

**Goal:** Run the Windows worker unattended, claim work promptly, retry network failures without losing completed separation, and reduce audio overhead without changing the agreed quality settings.

**Architecture:** Keep the API-only NestJS backend, MongoDB job queue, versioned S3 results, single assignment, leases, and generation fencing. Add bounded long polling, a durable local artifact checkpoint, and a contained reusable separator process. Windows Task Scheduler runs under the same configured account before interactive sign-in.

**Tech stack:** Existing Python 3.11+, audio-separator/DirectML, NumPy/soundfile, FFmpeg, Windows Task Scheduler/Job Objects, NestJS, MongoDB, external Redis, S3.

**Spec:** User-approved discussion in this task: Windows 11 Pro; Xeon E5-1660 v3; RX 580 8 GB; 24 GB DDR4; SSD; always awake with display off; automatic boot startup without sign-in; preserve quality first; benchmark two simultaneous jobs before enabling concurrency.

## Global constraints

- Preserve Kim_Vocal_2.onnx, DirectML, 44.1 kHz stereo input, the existing louder-channel RMS silence rules/padding/fades, and 192 kbps MP3 delivery.
- Do not enable simultaneous production GPU jobs or weaken the one-slot, stopped-attestation, heartbeat, cancellation, or generation checks.
- Preserve the current separator CLI and old worker claim requests; deployment ordering must be documented.
- Never persist bearer credentials, signed grants, source URLs, or raw subprocess error output in checkpoints or backend events.
- Work in the current checkout as requested; preserve unrelated changes and local/private configuration.
- Local tests do not prove Windows startup, DirectML performance, actual acoustics, or production service behavior.

## Task 1: Windows unattended availability

Files: `windows-worker/Install-Autostart.ps1`, a dedicated `musicmute_worker/power.py`, startup-focused tests and README instructions.

Interface: `KeepAwake` is a context manager used by the main worker loop. Request system execution without requesting display execution; always restore the previous execution requirements. The installer uses the current configured Windows account and securely prompts for its Windows password at installation time; never write that password to a file or command line. Existing task replacement is explicit and checks ownership/path.

- [x] Add focused tests for power acquisition/release/failure and startup configuration checks.
- [x] Verify failing tests, implement boot-triggered password-backed task registration and restart policy, and test locally where supported.
- [x] Document one-time Windows setup and reboot/sign-out verification; do not claim live installation.

## Task 2: Prompt pickup with compatible long polling

Files: worker controller/DTO, bounded wait service, focused backend tests, processing module and worker API documentation.

Interface: `POST /worker/claim` accepts optional `waitSeconds` (integer 0..25, default 0). Empty waits recheck durable MongoDB work at bounded intervals without retaining a database transaction. Client disconnect/shutdown releases wait resources. Existing callers remain immediate. Worker API transport uses a timeout longer than the requested wait and falls back for older servers.

- [x] Add DTO, timeout, newly available work, disconnect, and concurrent-claim regression tests.
- [x] Run focused tests red, implement the wait behavior, then run them green.
- [x] Keep successful completion followed by immediate claim; remove the 15-second idle sleep for supported long polls.

## Task 3: Transfer retries and durable artifacts

Files: `musicmute_worker/transport.py`, `worker.py`, new checkpoint/retry helpers as necessary, configuration, tests.

Interface: classify transient transfer errors and expose bounded Retry-After delays. Retry under the same live lease with short exponential delays and jitter. Refresh grants through authenticated existing worker operations. Ambiguous uploads are verified through completion/reconciliation before repeating expensive work. A checkpoint stores only confined local paths, input and separator fingerprints, validated durations, output checksum/size, and bounded recovery counts. Reuse a local result only after the backend authorizes the current job assignment and local integrity checks pass.

- [x] Test download retry, expired grants, ambiguous upload, completed result reused after restart/new assignment, checksum mismatch, cancellation during backoff, and retry exhaustion.
- [x] Implement bounded retry budgets and atomic checkpoint writes; clear the active checkpoint after terminal acknowledgement.
- [x] Ensure a lost response cannot silently overwrite the current assignment or publish stale output.

## Task 4: Preserve quality while reducing audio overhead

Files: `backend/separate.py`, contained process runner/engine helper, worker audio preparation, separator/engine tests.

Interface: validate and prepare canonical WAV in one FFmpeg decode; keep the standalone separator CLI compatible. Add a local file-based request protocol to a persistent contained separator engine with readiness, per-request ID, atomic response files, bounded waits, and sanitized error codes. Reuse one model sequentially, shut down containment on cancellation/lease loss, and restart cleanly. Batch RMS calculations with unchanged tail-frame and per-channel semantics; stream retained pieces rather than concatenate full audio copies. Retain PCM precision at existing quality boundaries.

- [x] Compare trimming samples against the legacy algorithm, including partial frames, all-silent input, stereo asymmetry, gaps, and fades.
- [x] Test model loaded once for two sequential engine requests using a fake separator; test crash/timeout/cancellation containment.
- [x] Verify decode-once behavior and output validation with actual local FFmpeg fixtures.

## Task 5: Benchmark, package, review, and validate

Files: Windows benchmark entry point, README, packaging whitelist/tests, this execution record.

- [x] Provide an offline benchmark for representative local clips, cold/warm runs and optional two-process comparison; never claim production jobs or send data externally.
- [x] Record elapsed stage times and dependency versions without secrets; leave production concurrency at one.
- [x] Run Python test suite, relevant backend tests/typecheck/lint/build, and isolated processing integration tests when available.
- [x] Review final scoped changes and fix regressions. Build and inspect a source-only Windows handoff ZIP and API deployment archive without deploying them.

## Execution record

The initial local handoff below is followed by [native Z440 deployment and validation](2026-09-10-z440-native-validation.md), authorized by the user's subsequent SSH/testing request. That record contains Windows-specific fixes, measured GPU performance, final package identity, and the remaining live-test limits.

- Planning: user authorized implementation; no additional approval is needed for source changes and local validation.
- Integration choice: current repository has untracked application trees and removed legacy files. Use file-scoped edits in place, no checkout reset or worktree based on incomplete HEAD.
- Deployment boundary: this host is macOS. Windows boot/sign-out, DirectML quality/performance, and production rollout require validation on the Z440/VPS after source validation.

### Local validation completed 2026-09-10

- Python 3.12 validation environment with NumPy, soundfile, FFmpeg/FFprobe and portable PowerShell: 99 supervisor/audio/package tests ran, 95 passed and 4 Windows-only cases skipped. The final benchmark suite ran separately: 8 passed. Total: **103 passed, 4 skipped**.
- Commands: `PYTHONPATH=windows-worker:windows-worker/tests python -m unittest -v test_processes test_engine test_separator test_transport test_worker test_reliability test_progress test_power test_autostart test_loop test_warm_worker test_package`; `PYTHONPATH=windows-worker python -m unittest discover -s windows-worker/tests -p test_benchmark.py -v`. The interpreter was `/tmp/musicmute-z440-validation-a08b78/bin/python`; `MUSICMUTE_TEST_POWERSHELL` selected the temporary portable PowerShell runtime for nine mocked installer tests.
- `ruff check windows-worker backend/separate.py` and `ruff format --check windows-worker backend/separate.py`: passed, 27 Python files formatted. PowerShell parser accepted all four packaged `.ps1` scripts.
- Backend `npm run format:check`, `npm run lint`, `npm run typecheck`: passed. `npm test`: 402 passed. `npm run test:e2e`: 38 passed. `npm run test:processing:integration`: build passed and 21 isolated MongoDB/Redis processing tests passed with no skips.
- Real local FFmpeg fixtures verify prepared-input decode avoidance and 44.1 kHz stereo / 192 kbps MP3 output. Fake audio-separator tests verify one model load for sequential requests; trimming output samples match the legacy reference. These do not measure RX 580 inference speed or acoustics.
- Reviews resolved output-parent confinement, warm-engine processor identity invalidation, Windows handle retention after failed termination, and benchmark preparation/partial-report/relative-path failures. Generation fencing and process-stopped requirements remain intact.
- Native checks still required: Windows global mutex, supervisor-crash Job Object containment, engine handle lifecycle, boot before sign-in, signed-out DirectML operation, a real queued job with in-app playback, and RX 580 cold/warm/two-engine measurements. Production remains one global job; no commit, push, deployment, or live machine configuration was performed.
- Handoff ZIP: `windows-worker/dist/MusicMuteWindowsWorker.zip`, SHA-256 `fdf664b158854acfadae3e7625e320fe0ef58cbecaede3ee794edd9f6e08ec35`. Built with `python windows-worker/package.py`; every entry matches final source, all archived Python sources compile, and local configuration/state are excluded.
- API archive: `/var/folders/jh/kqzv5jvj1qgfq85qwnwclz4w0000gn/T/musicmute-caprover-K7dL9n/api.tar`, SHA-256 `22f7c98fa77a04bc70fac349a3a631aec538c565328b601d250994f9a43e95bc`. Built with `npm run package:caprover`; 134 files include the root `captain-definition` and current worker API sources, with private/runtime files excluded. Upload using definition path `./captain-definition` and the existing port 80 configuration when deployment is authorized.
