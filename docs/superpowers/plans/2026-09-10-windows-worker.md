# Windows worker implementation plan

> Execute with the subagent-driven-development skill. Work in this checkout as requested; preserve unrelated files. No commits or deployment.

**Goal:** Run the user's proven DirectML separator on jobs from the existing backend and verify a real job on the Z440.

**Architecture:** A single Python supervisor owns one assignment at a time. HTTPS API calls use the worker bearer secret; transfers use separate signed S3 grants. Each media command runs in a contained process tree. A Windows Job Object terminates descendants when the supervisor exits. Persist only attempt identifiers and callback bodies, never grants or credentials.

**Tech stack:** Python 3.11+, standard library, existing audio-separator environment, FFmpeg/FFprobe, Windows Task Scheduler.

**Spec:** Approved design in conversation, `backend/docs/api/audio-processing.md`, and working `backend/separate.py`.

## Constraints

- Preserve DirectML, Kim_Vocal_2, trimming, 192k MP3 behavior.
- Heartbeat every 20 seconds; stop before confirmed lease expiry or on stale ownership/cancellation.
- One supervisor machine-wide, one job; contain FFmpeg descendants, including across crashes.
- Verify download checksum/size, full decode and actual duration <600 seconds, output codec/size/checksum/duration.
- Retry immutable callback bodies with the same event UUID. Reconcile uncertain outcomes only after process termination.
- No cloud data deletion. Retain attempt files locally and document disk requirements.
- The user will run the package on Windows; local automated tests cannot prove live DirectML or Windows containment.

## Tasks

- [x] Add process containment and instance lock (`processes.py`) with subprocess cancellation, timeout, descendant and lock tests.
- [x] Add validated configuration, isolated API/transfer clients, bounded transfers, and tests (`config.py`, `transport.py`).
- [x] Add journal and supervisor (`worker.py`) with heartbeat, validation, subprocess separation, uploads, idempotent callbacks and recovery tests.
- [x] Add `__main__.py`, Windows setup/start/task scripts, safe config example and README. Package only allowlisted source and the user's separator.
- [x] Exercise actual local HTTP and FFmpeg flows, fault cases, source review and archive inspection.
- [ ] User runs diagnostic and one queued job on the Z440; inspect output and backend/app ready proof before marking the goal complete.

## Verification commands

`PYTHONPATH=windows-worker python3.11 -W error::ResourceWarning -m unittest discover -s windows-worker/tests -v`

`python3 windows-worker/package.py` creates an allowlisted portable ZIP without configuration, audio, state or secrets.

On Windows: `powershell -ExecutionPolicy Bypass -File .\Start-Worker.ps1 -Check`, then `powershell -ExecutionPolicy Bypass -File .\Start-Worker.ps1 -Once`.

## Local evidence, 2026-09-10

- Python 3.11: 35 tests, 33 passed, 2 Windows-only tests skipped on macOS.
- Ruff 0.16.6 formatting and lint checks passed. The formatter is an isolated local development tool, not a worker dependency.
- Tests run real local HTTP transfers and FFmpeg commands, with a synthetic separator for supervisor behavior. They do not prove DirectML acoustics, production S3, or app playback.
- Review fixes cover lost reconciliation responses/reboots, truncated chunked HTTP responses, PowerShell 5.1 argument quoting, Windows newline handling, and test isolation from production Job Objects.
- The user chose to run the package on Windows. Windows native tests, actual queued-job completion and app playback are pending user-run evidence. No deployment or commit performed.
