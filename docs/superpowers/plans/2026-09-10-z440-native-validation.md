# Z440 native validation — 2026-09-10

## Scope and machine

The user authorized SSH access, source transfer, relaunch, and native testing in the existing Desktop/work/music_remover workspace. The machine has a Xeon E5-1660 v3, 24 GB RAM (23.9 GiB reported), Radeon RX 580 8 GB, and Windows 11 Pro. No media, private configuration, or credentials were removed or overwritten. No repository commit/push or VPS deployment was performed.

Installed runtime: Python 3.12.10, audio-separator 0.47.0, onnxruntime-directml 1.24.4, NumPy 2.5.3, soundfile 0.14.0, and FFmpeg 9.0.1. The installed worker's `Start-Worker.ps1 -Check` verified FFmpeg, FFprobe, separator syntax, and DirectML selection.

## Native findings and corrections

- Windows Job Object accounting reached zero before all member process handles signaled termination. Cleanup now closes child admission, captures member handles, terminates the job, and waits for every captured process. Incomplete snapshots cannot authorize a stopped acknowledgement. Failed owners and handles remain available for recovery.
- Windows intermittently denied reads of newly published IPC files. Bounded read retries preserve cancellation checks. Persistent failures remain fatal and contained.
- Process termination errors now escape media-error handling as `ContainmentError`, preserving the assignment journal and preventing false terminal acknowledgements.
- PowerShell test subprocesses explicitly use per-process execution-policy bypass; no machine execution-policy setting was changed. Benchmark timing uses a high-resolution clock and handles unmeasurably short intervals.
- Cloudflare returned HTTP 403/error 1010 for Python's generic User-Agent. The exact authenticated worker claim succeeded with the descriptive `MusicMuteWindowsWorker/1.0` identity. The transport now sends that identity while retaining proxy exclusion, redirect blocking, and credential separation.
- Switching the trimmed intermediate from FLAC to WAV exposed a codec-specific float-to-PCM16 rounding difference. The corrected writer explicitly preserves the original nearest-integer PCM16 quantization without reintroducing FLAC compression.

## Validation evidence

- Final packaged candidate, including transport and PCM rounding corrections: `python -m unittest discover -s tests -v` on Windows ran **121 tests: 119 passed, 2 POSIX-only cases skipped**, in 56.800 seconds (`selftest6.stderr.log`).
- Focused process/engine/quality suite: 47 tests ran successfully with 2 POSIX-only skips; 100 consecutive cancellation stress iterations passed.
- Local transport suite: 9 passed. Local worker recovery suite: 11 passed, including unverified-stop journal retention. The PCM regression failed before the rounding correction and passed afterward. The package integrity test passed. Final `ruff check windows-worker backend/separate.py` and `ruff format --check windows-worker backend/separate.py` passed. `git diff --check` passed.
- Independent review confirmed containment findings resolved and the User-Agent change preserves transport security boundaries.
- The existing macOS-only zombie-process cleanup race remains: a defunct process group can transiently return EPERM before its leader is reaped. Windows results are unaffected. A diagnostic runtime-only bounded-reap experiment succeeded 50/50; production source was not broadened to address this non-target platform issue.

## GPU benchmark

Two existing songs supplied 30-second stereo clips; each mode processed both clips twice. Inputs were prepared once. All modes use Kim_Vocal_2, DirectML, 44.1 kHz stereo, the existing silence trimming, and 192 kbps MP3 output. Times cover the mode's processing, including its model startup and shutdown; they exclude network transfers. The benchmark preceded the final PCM rounding correction.

| Mode                        | Four requests | Jobs/minute | Observation                                 |
| --------------------------- | ------------: | ----------: | ------------------------------------------- |
| New model for every request |       45.06 s |        5.33 | Each request approximately 10.67–11.38 s    |
| One reused model            |       25.15 s |        9.54 | Requests after initial loading: 4.53–4.83 s |
| Two reused engines          |       20.97 s |       11.45 | Later individual requests: 6.03–6.54 s      |

Model reuse reduced total elapsed time by 44.2% against cold requests. Two engines added approximately 20% throughput over one warm engine in this short experiment, while increasing individual latency. Production remains one global job and one warm engine; this benchmark does not establish sustained two-job reliability, long-file memory headroom, or a revised backend concurrency contract.

The original standalone separator processed the two clips in 14.83 s and 12.43 s. After the PCM correction, both clips were processed again on the RX 580 in 11.64 s and 12.24 s and their decoded MP3 samples matched the original baselines exactly: 970,200 and 2,646,000 sample values respectively, with maximum and RMS differences both zero. These separate runs are baseline observations, not a controlled long-duration throughput comparison. All outputs retain the original 11 s / 30 s trimmed durations, 44.1 kHz stereo, and 192 kbps encoding.

## Installation and operational proof

The original worker was stopped only after a fresh empty-queue log and null assignment journal. Thirty source-only package files were installed with archive/source hash verification. Original replaced source is backed up under `%USERPROFILE%\Desktop\work\music_remover\worker-backups\20260910-reliability-original`. The manual root separator and all example media remain intact. Configuration, DPAPI secret, Python path, and backend key-hash file were checked unchanged without displaying their contents.

The password-backed startup task was registered under the same configured Windows account with a startup trigger, no execution time limit, restart policy, and single-instance policy. The password was entered through a secure console prompt; it was not written to scripts or source files. Actual reboot/sign-out testing has not been performed.

During native processing, `powercfg /requests` showed a SYSTEM requirement from Python and no DISPLAY requirement. Thus processing prevented sleep while allowing the screen to turn off.

The installed final worker's `Start-Worker.ps1 -Once` returned `One-job run finished: idle` with exit zero after correcting the client identity. A real queued upload-to-result cycle and in-app playback remain unverified because the queue was empty. The VPS was not updated in this task; optional new API capabilities retain their compatibility fallback.

Remote evidence is under `%USERPROFILE%\Desktop\work\music_remover\updates\20260910-reliability-fdf664b1`: self-test logs, original baseline metrics, `native-benchmark/metrics.json`, `quality-corrected-candidate/comparison.json`, numeric comparison evidence, and source packages. Public timing/quality summaries use clip identifiers instead of private song names.

## Final read-back

Final source-only package: `windows-worker/dist/MusicMuteWindowsWorker.zip`, SHA-256 `a3fd6814eb6ba003e27473d01ad875345841c41d7bb0485c5b67d63ff2685afc`. The corrected separator SHA-256 is `5c361cf03c9f5603eef2403ed05c117e34bde51381a25d54d96b395f4a12983b`. Local package integrity test, Ruff checks, and formatting passed after the final patch.

All 30 installed source files were read back against the final package, with no mismatches and private configuration unchanged. `Install-Autostart.ps1 -Check` passed. `Start-ScheduledTask -TaskName 'MusicMute Windows Worker'` started the password-backed, limited-account task at 19:35:59 local time. Task Scheduler reported **Running**; the venv launcher and Python worker were both in Session 0. `powercfg /requests` confirmed the running task retained SYSTEM wake protection with no DISPLAY request. An actual machine reboot/sign-out was not performed.

A second read-back after 70 seconds still showed Running, the same Session 0 execution, zero new warning/error log entries, and no active assignment. The worker was left running under Task Scheduler.

## Dashboard registry cutover — 2026-09-11

The live dashboard initially returned an authenticated `200` response with an
empty worker list even though the Z440 worker could authenticate and process
jobs. Production was still using legacy worker authentication: that path
validated the configured digest directly, while the dashboard reads the
`audio_workers` registry. This later production cutover supersedes the earlier
reliability-pass note above that the VPS had not been updated.

Backend version 17 was deployed from a CapRover archive with SHA-256
`478819fd08a16ec276dfa38df809f828dc65811ab1282a29bd6d77d496091e7b`.
The production migration dry run proposed creating the `z440` registration,
preserving its control state, and backfilling 18 jobs plus 19 attempts. It found
no active controls, active jobs, active attempts, queued legacy-owned jobs,
non-legacy owners, orphaned records, duplicates, invalid records, or conflicts,
and reported that applying was safe. The explicit apply completed in two
batches, backfilled all 18 jobs and 19 attempts, and reported that fleet mode
could be enabled.

CapRover was then set to `PROCESSING_WORKER_AUTH_MODE=fleet` with the normal
`node dist/main.js` service command. Both the live and readiness probes returned
HTTP 200. The Z440 worker passed `Start-Worker.ps1 -Check` against fleet mode,
and its scheduled task was restarted with two Python worker processes and no
active assignment.

After refresh, the production Workers page showed `Z440` / `z440` as Enabled,
Online, Available, and without a current job. The detail view showed protocol
version 2, Idle, Available, and no recovery requirement. A second read 30
seconds later advanced the heartbeat revision from 6199 to 6236 and moved the
last-seen time forward, proving that the visible record was receiving live
heartbeats rather than only reflecting the migration. No new audio job or
in-app playback was run after this registry cutover, and reboot/sign-out proof
remains outstanding.

## Fleet protocol rollout — 2026-09-11

The dashboard-compatible Windows update was reviewed through two correction
rounds before deployment. The final local suite ran 139 tests successfully with
23 host/platform skips; the focused backend identity controller suite passed 5/5,
and backend formatting, lint, type checking, and build all passed. The 30-file
source-only ZIP has SHA-256
`6bd554490a3ddc91448c413a5e185c591f3a1b650b3b86f297ec1bf2f24f1833` and
contains no worker configuration, DPAPI credential, Python path, state, media,
or environment files.

Before replacement, an authenticated request made from the Z440 confirmed that
the live backend resolved the existing credential to worker `z440`, state
`enabled`, protocol version 2. The scheduled worker was then confirmed idle and
stopped without an active assignment. The staged candidate ran natively on the
Z440: 135 tests passed with 2 platform-expected skips. Installed checks then
confirmed DirectML, FFmpeg, FFprobe, separator syntax, and the existing Task
Scheduler definition.

Exactly the ZIP's 30 manifest entries were installed. The former source is backed
up under
`%USERPROFILE%\Desktop\work\music_remover\worker-backups\20260911-fleet-pre-6bd55449`;
deployment evidence, native test output, and the uploaded candidate are under
`%USERPROFILE%\Desktop\work\music_remover\updates\20260911-fleet-worker-6bd55449`.
Read-back hashes matched every installed source file. Existing configuration,
DPAPI credential, Python path, and durable state were excluded from the package
and verified unchanged across the source replacement.

The upgraded installed worker's `Start-Worker.ps1 -Once` claimed a real queued
job, progressed through validation, DirectML/Kim Vocal 2 processing, and upload,
and received the terminal `ready` acknowledgement. In-app download/playback was
not observed. The scheduled worker was restarted afterward; after 91 seconds it
remained Running with two worker Python processes in Session 0, installation
identity `z440`, no active assignment, zero new warning/error log entries, and
zero installed-source hash mismatches. The PC itself was not rebooted and the
previously documented reboot/sign-out proof remains outstanding.
