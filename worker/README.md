# MusicMute worker runtime

> **macOS per-user implementation:** the no-admin installer, logged-in-user
> LaunchAgent, lifecycle commands, direct-owner model download, signed manual
> updater, rollback, and self-unpair paths are the only supported macOS runtime.
> See the worker architecture documents for the approved lifecycle and security
> boundary.

This component contains the native machine supervisor and the isolated Python
processing child. It is intentionally separate from the NestJS backend and the
administrator dashboard.

The Node supervisor owns machine authentication, backend reconciliation, job
authority, leases, transfers, child lifecycle and sanitized diagnostics. The
Python child owns direct-input inference and result metadata. Audio
bytes never travel through the child control pipe, and the child never receives
backend or S3 credentials.

## Public-upload security boundary

The macOS LaunchAgent and Python child run as the logged-in user. A separate
process, private attempt directory and filtered environment are not an OS
sandbox: a native decoder exploit could access files allowed to that user.
Do not treat this deployment as containment for hostile public uploads on a
personal workstation. See [the public-upload review](../docs/worker-rebuild/validation/PUBLIC-UPLOAD-SECURITY.md).

Media subprocess output is bounded while being read; exceeding the limit kills
the tool. On POSIX, each processing child owns a process group so forced
termination and request timeout also terminate decoder descendants. A separate guardian observes supervisor
lifetime through an IPC channel, including when engine input is backpressured.
The Windows runtime uses a guardian-owned kill-on-close Job Object plus an
independent supervisor process-handle watcher. Native Windows acceptance remains
open; see the [implementation tracker](../docs/worker-rebuild/validation/RELIABILITY-IMPLEMENTATION-TRACKER.md). These controls do not provide a hard
CPU, GPU or resident-memory quota.

Service startup has a persisted five-start failure budget with jittered backoff.
Successful jobs and orderly shutdown reset it; abrupt process death consumes a
start. Permanent errors or exhausted admission leave the service quiescent and
log an operator recovery message. After fixing the cause, `mw restart` stops the
macOS service and resets its budget. Repeated idle-child exits also block admission.

Runtime diagnostics use a private acknowledged outbox for the existing backend log
endpoint. Network delivery runs separately from processing, retries exact pending
batches after uncertain acknowledgements, and bounds its state to 128 KiB. Large
records use numbered fragments under the backend line limit. A local spool entry
or Sentry capture call alone is not proof of remote archival or dashboard receipt.
If the outbox is missing, the worker reads the authenticated backend log cursor
before assigning new remote sequences. Deploy `GET /worker/logs/cursor` before
this worker version; an unavailable route defers delivery. Surviving pending
batches replay unchanged, and replacement local spools retain the remote cursor.
This recovers sequence continuity, not diagnostic bytes lost with deleted state.

macOS CLI and lifecycle mutations use persistent advisory-lock guard files.
The OS releases ownership when a command exits or is killed; guard files must not
be deleted during operation. Complete dead-owner records can be recovered under
that lock. Ambiguous legacy records require operator inspection.

If installation is interrupted after enrollment, rerun `mw install`. A private
finalization journal resumes local setup without requesting another one-use code.
Recovery preserves lifecycle intent and verifies the expected release before
starting the service. A loaded service still requires runtime health validation.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
uv venv .venv --python 3.13
uv pip sync --python .venv/bin/python ../tools/worker-gpu-feasibility/requirements-mps-base.lock.txt
pnpm run verify
```

On Windows, create the venv with the accepted Python 3.12 runtime and sync
`requirements-directml.lock.txt` instead. `MUSICMUTE_PYTHON` may point the test
runner at an already-qualified interpreter. Do not mix ONNX Runtime
distributions or install these locks globally.

The MPS base lock includes `onnx2torch-py313`; the worker imports its
`onnx2torch` module for the direct PyTorch MPS path.

The generated TypeScript protocol under `protocol/v1/` is copied from the
backend's canonical pure-data protocol. Run `pnpm protocol:sync` after an
intentional backend protocol change. `pnpm protocol:check` fails on drift.

Checkpoint D3 adds the authoritative HTTPS runtime loop: machine sessions,
policy acknowledgement, stable slot registration, same-request claim replay,
lease renewal/cancellation, attempt workspaces, exact-version transfers and
idempotent completion/failure. A machine opens one raw WebSocket using a
30-second, one-use ticket minted over authenticated HTTPS. Work, policy and
command hints only wake reconciliation; they never replace HTTPS claiming,
fallback polling or MongoDB ownership.

The service entry point reads a strict JSON config and a separate protected
machine-credential file:

```bash
mw run --config /absolute/path/runtime.json
```

```json
{
  "schemaVersion": 1,
  "backendBaseUrl": "https://api.example.invalid",
  "machineId": "00000000-0000-4000-8000-000000000000",
  "credentialFile": "/absolute/protected/machine.credential",
  "workRoot": "/absolute/private/attempts",
  "modelCacheRoot": "/absolute/private/models",
  "engineRoot": "/absolute/release/engine",
  "pythonPath": "/absolute/release/python",
  "ffmpegPath": "/absolute/release/ffmpeg",
  "ffprobePath": "/absolute/release/ffprobe",
  "validatedMaxWorkersPerGpu": 1,
  "capacityValidationFile": "/absolute/private/capacity-validation.json",
  "slots": [
    {
      "workerId": "00000000-0000-4000-8000-000000000001",
      "gpuId": "gpu-0",
      "slotIndex": 0,
      "recipeIds": ["kim-vocals-v2", "kim-vocals-v2-trim"],
      "provider": "mps"
    }
  ]
}
```

Use mode `0600` for the credential on POSIX systems. Plain HTTP is rejected
except when `allowInsecureLoopback` is explicitly true for isolated local
development. The model is not redistributed by this repository or through
MusicMute S3. The installer must download it from the exact owner-authorized
upstream URL in authenticated catalog metadata, verify its size and SHA-256,
and only then place it in the local content-addressed cache.

The runtime also keeps an ordered private diagnostic spool beside the attempt
root. Records are capped at 8 KiB, retained history is capped at 100 MiB with a
seven-day retention window, and signed URLs,
secret-like fields and user-home components are redacted before persistence.
Handled failures also submit sanitized, attempt-correlated Sentry events when
reporting is enabled; live delivery and backend log archival are separate
acceptance gates. If resource probes or the spool fail, new claims stop instead of treating
unknown capacity or logging loss as safe. Each job requires 2 GiB available
host memory and its declared input size plus a 2,300 MiB disk reserve; media and
subprocess outputs have their own hard caps. FFmpeg accepts only the fixed MVP
container allowlist through its local `file` protocol; playlist demuxers and
network inputs are not enabled.

The supervisor prepends only the configured FFmpeg directory to the processing
child's `PATH`. This lets `audio-separator` discover the same qualified,
immutable FFmpeg binary that the request names explicitly, without depending
on Homebrew, a logged-in shell or another global installation.

Only two runtime adapters are enabled: native macOS ARM64/PyTorch MPS with launchd
and owner-only POSIX credentials, and Windows x64/DirectML adapter 0 with a
Windows Service and LocalService NTFS ACLs. Linux, CUDA, MIGraphX, Intel Mac and
unqualified architectures remain disabled. D6 verifies this local boundary,
but passing local tests does not certify service startup, live S3, logged-out
GPU execution or production readiness; those remain D4/D5 platform gates.

## macOS per-user CLI and LaunchAgent

The public MVP entry point is a current-user install with no `sudo`:

```bash
npm install -g @musicmute/worker
mw install --label "Studio Mac"
```

The package installs `mw` as its CLI command.

The command reads the one-use enrollment code from `/dev/tty` with echo
disabled, uses `https://api.music-mute.com`, downloads the service
runtime beside any active release, verifies it, runs MPS qualification, and
then installs `~/Library/LaunchAgents/com.musicmute.worker.plist`. The
LaunchAgent always runs MusicMute's immutable private Node/Python/FFmpeg
runtime; it never mutates Homebrew, MacPorts, `/usr/local`, or the npm prefix.
If installation is interrupted, rerunning the same command reuses the protected
transaction credential instead of requesting another one-use code. After a
conservative `uninstall`, running `mw install` with no flags
verifies and reactivates the preserved paired release without enrollment or a
network download. A failed recovery removes the activation pointer again.

If an old one-use code was already consumed by a different exchange, create a
new code in the dashboard and run `mw install --label "Studio Mac"
--new-code`. The flag discards only a protected, pre-exchange local attempt and
prompts for the new code; it refuses to replace an attempt that has already
received an installation identity. A normal retry without this flag preserves
the original code and request identity for safe interrupted-install recovery.

Installation checks existing MusicMute-owned artifacts before network transfer.
An exact cached Kim Vocal 2 file is copied locally into the protected transaction
and causes no model request; an exact cached release archive or fixture is also
reused. The prepared service runtime is checked again before activation. Node
must report `>=24.18.0 <25`; FFmpeg and FFprobe must be the same version in
`>=8.0.3 <9`. Missing, older, untrusted, incomplete, or incompatible private
components require a newer verified private release. Global tools are detected
only for diagnostics and are never changed or spliced into the service. A model
cache miss downloads only from its owner-authorized upstream URL, never from
MusicMute S3.

Available local commands are `status`, `start`, `stop`, `restart`, `pause`,
`drain`, `resume`, `logs`, `doctor`, `benchmark`, `update --check`, `update`,
`unpair`, and `uninstall`. Every command prints a human-readable terminal view
by default; pass `--json` only when stable machine-readable output is needed by
a script or monitoring tool. `benchmark` deliberately requires the worker to
be already drained and stopped. `benchmark --workers 2` invalidates any previous
capacity approval before qualification, then records the
single-worker baseline, then runs two isolated MPS qualifications
concurrently. It writes an owner-only, seven-day capacity receipt only when
both accelerated runs preserve the model/release/fixture identity and improve
throughput by at least 1.1x. Runtime configuration defaults to one worker per
GPU, requires that fresh receipt to select two, and rejects more than two;
backend-approved machine capability and policy remain additional hard gates.
Version 2 receipts additionally verify the installed release inventory, executable
paths, model and fixture bytes, recipe set, and host/OS signature. Older receipts
require requalification. These checks do not replace sustained workload and output
quality acceptance before enabling two slots.
`update --check` verifies signed metadata
without minting a download grant or changing local state. `update` downloads a
verified candidate, checks the private Node/FFmpeg versions, qualifies MPS,
switches the release pointer atomically, restores whether the agent was running,
and, for a running service, runs the packaged
runtime doctor, and restores the known-good release if either startup or the
doctor fails. Failed candidates are locally quarantined. Mutating CLI commands
hold an owner-only process lock; a concurrent operation fails without changing
state, and a lock left by a dead process is recovered safely. `uninstall`
preserves state by default; `uninstall --purge` requires a backend-confirmed
`unpair` receipt first. Missing or manually deleted credential/config files are
not accepted as proof of unpairing.

`status --local` reads the service and worker snapshot without contacting the
backend. It reports observed loading, warm-up, processing, recovery, and pause
states, current stage and window progress, heartbeat age, and explicit
readiness blockers. Cached policy is labeled with its age and never shown as a
live connection. `status --watch` refreshes every two seconds and ends on
Ctrl-C without changing the service; add `--json` for newline-delimited JSON.
`start --wait-ready` waits up to six minutes for the local model to become
ready, prints phase changes, and then reports remote claim eligibility
separately. It does not override local or backend pause and drain settings.

Dashboard Doctor and Benchmark requests use the same running per-user worker
and never invoke `sudo`, install system packages, or modify the LaunchAgent.
Doctor runs only the requested bounded checks and reports sanitized metrics.
Dashboard Benchmark is deferred while a job is active; once idle, it
temporarily stops the private processing child, runs the one frozen Kim Vocal 2
recipe exactly once against the installed qualification fixture,
restarts the child, and reports aggregate timing and output-size metrics. A
lost result response is retried with the same request identity without rerunning
the diagnostic or benchmark. This remote idle-only behavior is separate from
the local `benchmark` command, whose explicit drained-and-stopped precondition
remains unchanged.

### Logs and support diagnostics

The per-user service writes owner-only stdout/stderr logs under
`~/Library/Application Support/MusicMuteWorker/logs/` and structured runtime
events under `jobs/logs/`. Stdout and stderr rotate automatically at 5 MiB,
keeping five gzip archives per stream. Structured diagnostic history retains
up to seven days under a 100 MiB aggregate budget. Old segments are evicted
before normal quota pressure can stop new claims. Actual write failure or
corruption still blocks admission until repaired.

```bash
mw logs
mw logs --events --since 2h
mw logs --errors --attempt-id <attempt-uuid>
mw logs --events --level error --follow
mw logs --events --follow --json
mw job <job-id> --json
mw errors --since 1d --limit 20
mw explain GPU_OOM
mw perf --last 20 --since 1d --json
mw doctor
mw doctor --full
mw logs --clear
mw diagnostics
mw diagnostics --job <job-id> --since 1d
```

`logs` shows readable stdout/stderr by default. Structured views accept
`--attempt-id`, `--since` (`s`, `m`, `h`, or `d`, up to 30 days), and
`--level info|warning|error`; `--follow --json` streams one JSON object per
new event or text chunk.
`status` includes the runtime heartbeat, child state, current and last jobs,
spool state, and total log disk use.

`job` reconstructs the attempts this worker retained for one backend job ID,
including observed stage durations, retries, failure codes, and child restarts.
It exits 2 when there is no local evidence; the job may have run elsewhere or
aged out of history. `errors` groups recent local failures by code, component,
and stage with affected-job counts and recovery evidence. `explain` shows a
sanitized definition, observed examples, and read-only next steps. These
commands do not contact the backend or retry work. JSON output includes a local
history scope and an incomplete-history flag.

`doctor` is a quick local check: files, config, LaunchAgent, and runtime status.
`doctor --full` also verifies the active release and invokes the installed
Python runtime integrity check, including model and GPU provider availability.
Quick checks do not load another model. Installation and activation continue to
require the full integrity check. Doctor JSON marks checks as passed, failed, or
not run and includes safe reason codes and next actions.

`perf` reports the last 1–100 locally observed attempts, with optional time and
recipe filters. Successful samples include measured download, separation,
upload, and completion acknowledgement durations. Revision 5 records mandatory
trimming and the single final encode for both recipe names. The report includes decoded
input duration, output size, and separation real-time factor when available.
It separates failed, stopped, active, and retried attempts. Medians and ranges
are computed only within cohorts sharing provider, logical GPU slot, runtime
incarnation, model/recipe digest, output bitrate, group size, warm-model state,
and a five-second input-duration bucket. A long “Removing music” display stage
alone does not prove separation is the bottleneck; the report explicitly lists
unmeasured queue time and other missing coverage.

`diagnostics --job <id>` creates a private ZIP with only that job's retained
attempt timeline, performance samples, grouped errors, safe status and Doctor
checks, and a manifest of missing sections. `--since` bounds the export (seven
days by default). General diagnostics still works without a job ID. Bundles
are capped at 8 MiB, reject an existing target, and contain no raw stderr,
source media, file paths, tokens, signed URLs, or config values.

`logs --clear` is the explicit destructive maintenance command. It truncates
the active stdout/stderr streams, removes their known archives, and clears
structured history under the writer lock. It keeps the running service and
warm model in place. A diagnostic failure marker remains until the underlying
write or corruption problem is repaired. Configuration, credentials, models,
job files, diagnostic ZIP exports, and unrecognized files are preserved.
Add `--json` for automation.

`diagnostics` creates an owner-only ZIP in `~/Downloads`, or at an absolute
path inside the current home supplied with `--output`. It contains sanitized
status, Doctor results, recent events/errors, and configuration field names
only. It never includes credentials, configuration values, media, models,
signed URLs, or unredacted user paths. These commands never request `sudo`.

`status` combines protected local lifecycle/runtime state with the read-only
machine-authenticated `GET /worker/status` response. It reports the
dashboard machine status, policy revision, last contact, active-attempt count,
and effective claim permission. If the backend is offline, remote state is
explicitly unavailable and the command returns an unhealthy exit instead of
guessing that local `resume` overrides dashboard authority.

`start` leaves an already-running service and its model process intact. A loaded
but stopped service starts with a non-killing LaunchAgent kickstart. `resume`
changes local claim intent without restarting the service; an already-running
worker wakes when the lifecycle file changes, with its bounded idle poll as a
fallback. `resume` does not start a stopped service or override backend policy.
Use explicit `restart` when a fresh process is required.

The service publishes only bounded active-attempt IDs to its protected local
runtime-status file. Normal `drain`, `stop`, `restart`, and `update` therefore
stop new claims and wait up to ten minutes for active work. Missing status or a
deadline expiry fails closed; `--force` is the explicit lease-recovery escape
hatch for stop, restart, and update.

Update metadata uses Ed25519 and a monotonic sequence. The reviewed production
public key is a built-in CLI trust anchor keyed by the catalog `keyId`, so a
missing optional local trust file does not break read-only update checks.
Additional rotation keys may be placed in the owner-only
`~/Library/Application Support/MusicMuteWorker/config/update-trust.json` map.
Malformed local trust, attempts to replace a built-in key, and unknown catalog
keys fail closed. Production private signing keys stay outside Git, npm
packages, backend responses, and worker machines.

## macOS per-user release package

The macOS packager accepts only a native Darwin ARM64 host and an already
qualified private runtime. It packages the compiled worker, processing engine,
standalone Node and Python roots, and the media runtime without configuration,
credentials, models, or job data.

```bash
pnpm run build
mw package-macos \
  --worker-root /absolute/source/worker \
  --output /absolute/staging/musicmute-worker \
  --version 0.1.0 \
  --node-root /absolute/private/node \
  --python-root /absolute/private/python \
  --media-root /absolute/private/media-runtime
```

## Windows private release and service

Build Windows packages only on native x86_64 Windows from already-qualified
private Node, Python 3.12/DirectML and offline FFmpeg roots. The packager audits
every executable as PE32+ x86_64, rejects links, and records every release file
by byte count and SHA-256. WinSW 2.12.0 is the stable pinned service wrapper;
the helper downloads only its official x64 asset and license and verifies their
fixed hashes.

```powershell
powershell.exe -NoProfile -File .\scripts\build-windows-service-runtime.ps1 `
  -OutputPath C:\MusicMuteBuild\winsw-runtime
pnpm run build
node .\dist\src\cli\main.js windows package `
  --worker-root C:\src\music_remover\worker `
  --output C:\MusicMuteBuild\musicmute-worker-0.1.0-win `
  --version 0.1.0-win `
  --node-root C:\MusicMuteBuild\node `
  --python-root C:\MusicMuteBuild\python `
  --media-root C:\MusicMuteBuild\media-runtime `
  --service-root C:\MusicMuteBuild\winsw-runtime
```

From an elevated PowerShell prompt, the packaged manager installs or repairs
the versioned release under `%ProgramData%\MusicMuteWorker`, applies restrictive
ACLs, verifies the exact Kim model, writes a password-free LocalService WinSW
definition, and rolls back the definition if its local doctor fails. The
runtime config must select exactly one DirectML slot on adapter `0` and use the
matching versioned runtime paths plus the stable state paths.

```powershell
powershell.exe -NoProfile -File C:\MusicMuteBuild\musicmute-worker-0.1.0-win\installer\manage-windows-service.ps1 `
  -Action Install `
  -Release C:\MusicMuteBuild\musicmute-worker-0.1.0-win `
  -Config C:\MusicMutePrivate\runtime.json `
  -Credential C:\MusicMutePrivate\machine.credential `
  -ModelSource C:\MusicMutePrivate\Kim_Vocal_2.onnx

powershell.exe -NoProfile -File C:\MusicMuteBuild\musicmute-worker-0.1.0-win\installer\manage-windows-service.ps1 -Action Doctor
```

After repairing a restart-budget exhaustion cause, drain the worker and stop
`MusicMuteWorker`. From an elevated PowerShell prompt, reset its budget and then
explicitly start it:

```powershell
powershell.exe -NoProfile -File C:\MusicMuteBuild\musicmute-worker-0.1.0-win\installer\manage-windows-service.ps1 -Action ResetRestartBudget
Start-Service -Name MusicMuteWorker
```

For a custom installation, supply the same `-InstallRoot` used during install.
Reset refuses a running service, preserves the previous budget under a unique
`restart-budget.reset.*.json` name, and leaves the service stopped. Unsafe or
invalid-sized budget files fail closed for operator inspection. The next start
creates a new budget with the service's normal state-directory permissions.
Native Windows service and ACL acceptance for this operation remains pending.

`Repair` accepts the same four private inputs. `Uninstall` removes only the
Windows Service definition, stable wrapper and active-release marker; releases,
credentials, models and job state remain preserved. The scripts never bypass
PowerShell policy, alter global Node/Python, or install/replace a GPU driver.
Local package tests do not prove LocalService GPU access, logged-out operation,
restart/reboot recovery, live S3, or actual Z440 execution; those stay `NOT_RUN`
until the owner-authorized Windows host run.

### Offline song benchmark (macOS)

With the worker already drained and stopped, benchmark the UVR-compatible MPS
engine directly. This command does not contact the backend, S3, or a database.
During local development, build this worktree and run its CLI directly so the
new command is not confused with an older installed release. Use a full-length
local song and keep its source unchanged across reports:

```sh
pnpm --dir /absolute/path/to/worktree/worker build
node /absolute/path/to/worktree/worker/dist/src/cli/main.js benchmark-file \
  --input /absolute/path/song.mp3 \
  --recipe kim-vocals-v2-trim \
  --candidate-engine /absolute/path/to/worktree/worker/engine \
  --warmup-runs 1 --runs 3 --group-size 1 \
  --report /absolute/path/to/new-report.json \
  --save-audio-dir /absolute/path/to/new-audio-directory \
  --json
```

The runner preloads one model, records the first full pass as cold, performs
zero to two extra warm-up passes, then measures three to ten warm passes in
the same Python process. It reports every run, median and range, stage
timings, decoded input metadata, code/model/recipe hashes, MPS provider proof,
and boundary GPU allocation observations. The cold label includes preload
and first-pass context; it does not claim an uncached OS or GPU driver. The
memory readings are process allocations at run boundaries, not peak GPU
occupancy. `--json` streams progress objects followed by a final report.
The CLI passes MP3 and WAV directly to the separator. It decodes every other
accepted format to a temporary WAV, records that time as `preparation`, and
removes the WAV after separation or failure. The benchmark workspace is also
removed when the CLI command finishes.

`--candidate-engine` imports the worktree engine through a private Python path
while keeping the installed dependency runtime. The report records a digest
of candidate source files separately from the installed release manifest
digest. It does not alter installed site-packages or the signed release.
`--save-audio-dir` is optional and must name a new private directory; it saves
the final MP3 vocals for quality review. `--report` saves a new private
JSON file. A failed run leaves a sanitized partial diagnostic report under the
worker state directory. `--baseline-report` compares saved reports only when
the source, model, recipe, audio settings, GPU model, OS, and dependency runtime
match. Incompatible reports show reasons and no speedup. Group sizes 2 and 4
remain available for comparison. Production uses group size 2 on MPS and 1 on
DirectML; on the tested M4 Pro, group 2 outperformed groups 1 and 4 with PCM
differences within the baseline repeat-run variation. CPU inference and MPS fallback are disabled
for this benchmark.

Warm jobs reuse the loaded model's verified identity rather than rehashing its
on-disk artifact. Every new child verifies before loading; a warm child rejects
cache/provider/model identity changes. Disk corruption is detected on the next
load, while existing children continue using their verified in-memory graph.
Prepared PCM16 WAVs receive bounded metadata and final-frame checks instead of a
full finite-sample scan; floating-point audio retains the scan. Input checksums
and final-output checksums remain enforced.

Production children preload the verified model before announcing readiness and
keep it resident between jobs. Kim Vocal 2 converts the verified ONNX model with
`onnx2torch`, runs on MPS with segment size 256 and UVR Default overlap
(`7680 / 261120`), and writes a private PCM16 vocal WAV directly through
soundfile. MP3 and WAV inputs go directly to the separator; other accepted
formats are decoded to a bounded local WAV first.

For primary-vocal output, the worker skips the unused secondary-stem and
`match_mix` passes. Local success diagnostics include `separationMixPreparation`,
`separationPrimaryDemix`, `separationMatchMix` (zero when skipped),
`separationWavWrite`, and `separationCleanup`. These are subdivisions of the
existing separation stage, not additional work or backend processing stages.

Both `kim-vocals-v2` and the compatibility name `kim-vocals-v2-trim` now use
recipe revision 5: separate to WAV, trim WAV, encode one final 160 kbps MP3,
then validate it. Trimming is mandatory. The reference algorithm remains:
10 ms louder-channel RMS windows, a strict -32 dBFS threshold, 0.6-second minimum
gaps, 0.2-second retained padding, 5 ms boundary fades, and all-silent
preservation. If no samples are removed, encoding reads the existing separated
WAV instead of writing another copy. All generated WAVs are removed on success
and failure; the final MP3 alone is published.

Final MP3 encoding uses LAME `compression_level=7`, trading encoding analysis
quality for speed while retaining 160 kbps, stereo, and 44.1 kHz. Three-run
local benchmarks on two vocal WAVs measured 48–51% less encoding time than
the default setting; this is not an end-to-end production speed guarantee.

The uploader starts a streaming PUT after receiving the checksum-bound backend
grant. It hashes bounded chunks while uploading and withholds the final chunk
until size and checksum match. There is no full-file buffer or extra pre-upload
hash pass. S3's signed checksum, immutable version, retries and completion
checks remain required. The final checksum and upload grant must exist before
upload starts; network latency cannot be eliminated by local processing.

Rollout requires the matching backend recipe catalog and worker together.
Drain old-revision queued/in-flight jobs with the old worker before switching;
revision 4 snapshots are not silently reinterpreted as revision 5. Historical
records retain their original step IDs. No database migration or deployment is
performed by these source changes.

Local validation on 2026-09-24: 62 Python engine tests and 267 TypeScript worker
tests passed (2 platform-specific tests skipped). Backend verification passed
807 unit tests and 140 HTTP tests; the isolated compiled backend/worker job-flow
test also passed with fixture storage. A real local MPS smoke run using a
six-second synthetic fixture produced and decoded the final MP3, ran mandatory
trimming, and left no generated WAVs. Its measured stages were 1.186 seconds
separation, 0.002 seconds trimming, and 0.141 seconds encoding. This is a
functional smoke test, not a comparative benchmark or live-S3/deployment proof.
Android DirectDebug unit tests, lint and APK assembly passed; no device/UI or
listening acceptance was performed.

Historical measurements below predate revision 5 and are not its benchmark:

On 2026-09-23, the worktree Python engine ran the verified model on an M4 Pro
with a 162.3-second MP3 using the setup note's Python 3.12.13 environment,
`audio-separator` 0.47.0, and MPS fallback disabled. In the first session, the
plain job took 14.08 seconds and a trimmed job took 11.63 seconds, including
9.88 seconds of separation, 0.21
seconds of trimming, and 1.42 seconds of re-encoding. Model preload and warm-up
were separate from those job times (24.65 seconds in the first session). In a
second session, two plain jobs took 10.24 and 9.99 seconds. These
are local candidate-engine measurements, not a packaged CLI or full backend
job benchmark. Listening review of the output remains pending.

Job downloads and uploads enforce a 30-second inactivity timeout in addition to
total and ownership budgets. Upload progress measures body consumption by the
HTTP client, not remote acknowledgement of each byte. Transient reconciliation
errors receive bounded recovery; exhausted child recovery and unsafe workspace
cleanup remain admission blockers. See the
[ranked reliability audit](../docs/worker-rebuild/validation/PRODUCTION-RELIABILITY-AUDIT.md)
for reproduction cases, local test evidence and remaining production gates.
