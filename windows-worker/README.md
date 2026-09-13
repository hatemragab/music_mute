# MusicMute Windows worker

Runs the existing `separate.py` against the backend's durable queue. The package
preserves DirectML, `Kim_Vocal_2.onnx`, silence trimming, and 192 kbps voice MP3.
Use the same Windows account and Python environment that already ran the script
successfully. No new Python package installation is required by the supervisor.

## First run on the Z440

1. Extract `MusicMuteWindowsWorker.zip`. It contains a new `MusicMuteWindowsWorker`
   folder. Put that folder inside your existing working directory next to `.venv`:

   ```text
   YourExistingFolder/
     .venv/
     separate.py                 (your existing file remains unchanged)
     MusicMuteWindowsWorker/
       Configure-Worker.ps1
       Start-Worker.ps1
       separate.py               (packaged copy of the supplied script)
       musicmute_worker/
   ```

2. Open PowerShell in `MusicMuteWindowsWorker` and configure it:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Configure-Worker.ps1
   ```

   It detects `.venv` in this folder or its parent. Otherwise it asks for the full
   path to your working `.venv\Scripts\python.exe`. Enter the non-secret worker ID
   registered for this PC (`z440` remains the default for the existing machine),
   your backend HTTPS URL including `/api/v1`, then the **raw worker secret** at
   the hidden prompt.
   In fleet registry mode, use the one-time raw secret returned when that worker
   is registered; the backend stores only its digest. For the legacy `z440`
   configuration, use the raw secret whose SHA-256 hex digest is configured as
   `PROCESSING_WORKER_KEY_SHA256`. A digest itself cannot authenticate.

   The script stores non-secret settings in `worker.config.json`, binds durable
   state to that API URL and worker ID in `state\installation.json`, stores your
   Python path in `python.path`, and encrypts the secret with Windows DPAPI in
   `worker-secret.dpapi`. Only that Windows account on that machine can normally
   decrypt it. Do not send these files or copy the configured folder to other PCs.
   The secret is removed from the Python environment before any separator child
   is started. No AWS keys are needed.

   Every worker verifies authenticated protocol-v2 identity before its first
   claim. A backend identity that differs from `worker_id`, or an old backend
   without the identity route, stops safely before claiming. Do not copy another
   PC's DPAPI file, configuration, session, assignment journal, or progress state.
   Setup acquires the same machine-wide exclusion as the worker before inspecting
   or persisting state, so it refuses to run while any worker process is active.
   Reconfiguration also refuses to change worker ID or API URL while `active.json`
   contains an assignment; reconcile it with the current configuration first.

3. Check the existing environment, without claiming a job:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Start-Worker.ps1 -Check
   ```

   Expected final line: `Local checks passed: separator syntax, FFmpeg, FFprobe and DirectML.`
   This does not download the model or prove an actual separation. Your previous
   manual test provides the initial model/separation check.

4. Run the bundled automated checks **on Windows**. These use synthetic local
   audio and an isolated local HTTP server; they do not contact your real API:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Start-Worker.ps1 -SelfTest
   ```

   All tests should pass on Windows, including the process-crash and global-lock
   tests that cannot run on macOS. Stop here and send the error if they fail.

5. Keep one real job queued in the app and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Start-Worker.ps1 -Once
   ```

   Expected sequence: `validating`, `processing with DirectML / Kim Vocal 2`,
   `uploading result`, `ready`, then `One-job run finished: ready`.
   Open the job in the app, refresh if needed, download and play the result.
   `idle` means the backend had no queued job. `failed` means the backend recorded
   an error; inspect the app's error and the safe local `state\worker.log`.

   If interrupted, rerun the same command in the same folder. It reconciles the
   saved attempt before doing more work. Never delete the `state` folder to bypass
   recovery. Keep `installation.json`, `session.json`, `active.json`, and
   `progress.json` in `state`.
   The durable installation session also recovers a lost initial claim response
   when the updated backend confirms ownership. A different installation refuses
   to attest that unknown old processing stopped.

   A draining fleet worker may receive `released` after stopped reconciliation.
   The worker clears only `active.json`, retains its local media/checkpoint under
   the existing retention policy, and returns to idle. A cancelled recovery keeps
   the existing terminal cleanup and cancellation acknowledgement behavior.

6. After the one-job test passes, run continuously:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Start-Worker.ps1
   ```

   Use Ctrl+C to stop. While processing, it sends heartbeats every 20 seconds and
   checks cancellation every 200 ms between network operations. A cancellation
   is discovered by the next heartbeat, so stopping is not instant. Network calls
   normally have 15-second socket timeouts; a 25-second claim wait uses 40 seconds.
   Lost ownership stops contained processes before
   recovery; successful processing is not assumed from process exit alone.

## Automatic startup

After the manual checks pass, stop the manual worker and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Autostart.ps1
Start-ScheduledTask -TaskName 'MusicMute Windows Worker'
```

This creates an **at-boot** task that runs before anyone signs in, under the same
Windows account that encrypted the worker secret. Enter that account's Windows
password in the secure credential prompt; a Windows Hello PIN cannot be used.
Task Scheduler stores the credentials using Windows facilities. The installer
does not write the password into the worker folder or enable automatic login.
The task has no execution time limit and restarts up to 255 times at one-minute
intervals after failures. Local Windows policy must allow this account to run
scheduled tasks while signed out.

For an existing installation, stop the scheduled/manual worker first and use
`Install-Autostart.ps1 -ReplaceExisting`. Replacement refuses a task from another
account or folder and refuses a running task. Inspect the saved task and DPAPI
decryption without changing settings using:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Autostart.ps1 -Check
```

Keep this folder and the existing `.venv` at their saved locations. A machine-wide
mutex prevents two workers from running even from different folders. While the
worker is running, it requests that Windows stay awake, including while waiting
for work; the screen can turn off. It restores the previous execution requirement
when it exits and does not permanently change the power plan. Keep AC power and
network connectivity available. Sleep/offline time cannot process jobs.

**Verify on the Z440:** complete one queued job through Task Scheduler, then reboot
without signing in and submit another job from the app. Confirm it reaches `ready`
and plays. Also check a signed-out run. DirectML availability in this noninteractive
session must be proven on the RX 580; local source tests cannot establish that.

## Recovery and performance settings

The backend supports `claim_wait_seconds` (default 25, range 0..25). It checks the
durable queue once per second during a wait, and the worker claims again immediately
after finishing a job. Configure any reverse proxy timeout above 40 seconds.
Older servers reject the optional claim field; the worker then falls back to
one-second polling. Install the updated backend first for durable lost-claim
recovery, then replace the worker source while keeping its local state/configuration.

Transient transfers retry up to `transfer_attempts` (default 5, range 1..10), with
short exponential delays, jitter, and `Retry-After`, within
`transfer_retry_budget_seconds` (default 120, range 15..600) per transfer phase.
Attempt counts survive restart for the same input and separator fingerprint.
The worker refreshes signed grants and checks cancellation/ownership between I/O.
After an ambiguous upload, completion verifies storage before another upload.
Checkpoints contain file sizes/checksums and durations, never signed grants or
worker credentials. A verified local MP3 can be reused after backend reconciliation;
a changed input, separator, dependency version, or checksum requires fresh work.

`reuse_separator` defaults to `true`. One contained child keeps the Kim Vocal 2
model loaded and accepts one job at a time. Validation prepares the existing
44.1 kHz stereo PCM WAV once; the separator consumes it directly. Trimming retains
the existing RMS thresholds, padding, fades and tail-frame behavior, and output
remains a 192 kbps vocal MP3. Set `reuse_separator` to `false` for a fresh separator
process per job. Production keeps **one global assignment and one GPU job**.

## Offline benchmark on the Z440

Benchmark preparation accepts audio-only inputs up to 1800 seconds and 100,000,000
bytes, inclusive, to qualify the proposed media policy. This does not expand live
worker admission: claimed assignments carry versioned limits only after capability
negotiation, and local output/time safety settings remain authoritative. Record
actual hardware and cold/warm measurements before enabling expanded server policy.

Separator execution evidence is checkpointed separately from upload/queue time.
An unobserved crash interval is reported as unavailable; recovery never invents
elapsed execution or a zero-cost cancellation.

Stop the worker/task, then benchmark representative short and long local clips:

```powershell
.\Benchmark-Worker.ps1 -InputFiles @('C:\Audio\short.mp3', 'C:\Audio\long.m4a') -Repeats 2
.\Benchmark-Worker.ps1 -InputFiles @('C:\Audio\short.mp3', 'C:\Audio\long.m4a') -Repeats 2 -CompareTwo
```

The benchmark does not claim queue work or load the worker secret. It compares
cold processes with a reusable model and optionally two simultaneous isolated
models, using the same prepared clips. It records stage and wall times in a local
JSON report with anonymous clip IDs. The existing audio-separator library may
download its model if it is not already cached. Review throughput, GPU/RAM usage
in Task Manager, failures, and audible quality on the 8 GB RX 580 / 24 GB Z440.
The optional comparison does not enable concurrent production processing.
Retain one production job until this hardware measurement justifies a separate
backend/worker concurrency change.

## Storage and boundaries

Input/output files under `state\jobs` are retained; no automatic media deletion is
implemented. Monitor free disk space. The separator removes its own temporary
intermediate files as it already did. Cloud originals/results are not deleted.
Only safe stage messages and job IDs enter the rotating worker log; subprocess
output, signed URLs and secrets are never sent as backend failure messages.

Keep Windows time synchronized: lease deadlines are based on backend UTC timestamps.
Only one Z440 may use this worker identity. Do not reuse the secret on another
machine; the backend cannot verify that a remote process actually stopped.

The supervisor uses Windows Job Objects to contain Python/FFmpeg descendants,
including if the supervisor crashes. It validates input size/checksum, actual
decoding and duration below 600 seconds. It validates output MP3 decoding, actual
duration, size and checksum. Voice isolation is supplied by the fixed separator
model; file metadata cannot prove acoustic quality. Trimmed results can be shorter
than the input.

`output_max_bytes` must match the backend's exclusive limit (default 30,000,000).
`processing_timeout_seconds` defaults to two hours per separator run. The worker
does not install Redis, MongoDB, an HTTP server, or a second queue on Windows.

## Local development and packaging

From the repository root:

```sh
PYTHONPATH=windows-worker python3 -m unittest discover -s windows-worker/tests -v
python3 windows-worker/package.py
```

The ZIP uses an explicit source allowlist and copies `backend/separate.py` exactly.
It excludes credentials, local configuration, media, state, caches and environments.
The production CLI is Windows-only; POSIX subprocess support exists for local
tests and does not claim Windows crash containment proof.
