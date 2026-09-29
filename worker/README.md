# MusicMute worker runtime

> **Release candidate:** `0.1.0-rc.1` prepares the public Apple
> Silicon macOS package. [RELEASING.md](RELEASING.md) describes artifact checks,
> native acceptance and separately authorized publication/catalog promotion.
> The npm CLI and managed service runtime are separate artifacts.

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

The shared Kim loader verifies the full model SHA-256 and constructs the pinned
MDX architecture with fixed inference parameters. It does not use upstream model
catalog discovery or download metadata during processing. Model acquisition is
the separate, verified owner-source installation step.

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
independent supervisor process-handle watcher. Native Windows acceptance and its scope are recorded in the
[current readiness report](../docs/worker-windows-macos/READINESS.md). These controls do not provide a hard
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

Worker HTTP calls use root-mounted `/worker/...` routes and snake_case JSON and
query names. The authenticated cursor call sends `session_id` and
`incarnation` and reads `acknowledged_sequence`; it requires a backend with
this route deployed before diagnostic delivery can resume. See the
[API client contract](../docs/api/client-contract.md) and
[OpenAPI](../backend/openapi.yaml) for the credential scopes, error behavior,
and complete current route schemas.

macOS CLI and lifecycle mutations use persistent advisory-lock guard files.
The OS releases ownership when a command exits or is killed; guard files must not
be deleted during operation. Complete dead-owner records can be recovered under
that lock. Ambiguous legacy records require operator inspection.

The macOS service controller waits for launchd to remove the registration after
`bootout`, with a thirty-second deadline. Qualification, update and removal must
finish that teardown before replacing the service or its files. Inspection
errors fail the operation; a missing `launchctl` executable is not evidence that
the worker stopped.

Windows explicit stop also accounts for crash restarts already queued by the
Service Control Manager. The native controller verifies the installed helper,
journals the recovery policy, disables the service until the saved restart delay
has elapsed, verifies Stopped/PID 0, then restores the policy. This also runs when
SCM initially reports Stopped. An interrupted stop retains stopped recovery
intent. Native test and installed-package evidence are recorded separately in
[the Windows/macOS ledger](../docs/worker-windows-macos/IMPLEMENTATION.md).

Runtime status publication retains the previous complete snapshot while a
Windows reader holds a handle that prevents replacement. Transient rename
failures retry for at most two seconds; persistent failures remain errors, and
unpublished temporary files are removed. Native tests exercise actual Windows
file sharing, including preservation of the old snapshot during the wait.

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

The runtime owns one hint socket per machine process. A successful handshake
cancels its connection deadline; short-lived failures use exponential backoff
with jitter, while a stable connection resets that backoff. The API enforces a
renewable Redis lease so the same machine identity cannot hold concurrent hint
connections across API instances. Server ping/pong detects dead connections and
the connection rotates hourly without changing the authenticated HTTP session.

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

## Install the shared npm CLI

Install Node.js `>=24.18.0 <25`, then install the same CLI on either supported
platform:

```sh
npm install -g @music-mute/worker
mw --version
```

The npm package contains the CLI. The authenticated installer separately obtains
the platform runtime, verifies its Ed25519 signature and archive digest, downloads
the model from its authorized owner, qualifies the GPU, and enrolls the machine.
An administrator creates a one-use code in Workers → Enrollment. Installing the
public CLI alone does not admit a machine to the fleet.

| Platform            | Runtime                          | Installation and startup                                         |
| ------------------- | -------------------------------- | ---------------------------------------------------------------- |
| Apple Silicon macOS | PyTorch MPS                      | Current user, no sudo; LaunchAgent starts at login               |
| Windows x64         | ONNX Runtime DirectML, adapter 0 | Elevated PowerShell; LocalService Windows Service starts at boot |

Recorded qualified hardware is an Apple Silicon Mac with 24 GiB RAM and an HP
Z440 with Windows 11 Pro, Xeon E5-1660 v3, 24 GiB RAM and Radeon RX 580 8 GiB.
These are tested configurations, not proven minimum requirements. Other compatible
GPUs must pass installation qualification. Intel Mac, Windows ARM64, Linux/Ubuntu,
CUDA and MIGraphX are not supported by this release. Keep enough free disk for
the private runtime, model, staged updates and job scratch; a minimum disk/RAM
limit for arbitrary input lengths has not been established.

### Windows first installation

Run this in **PowerShell as Administrator**. The code is read without echo and
kept in a directory accessible only to Administrators and SYSTEM. Use a fresh
directory for each enrollment and reuse it when retrying an interrupted install.

```powershell
$container = Join-Path $env:ProgramData 'MusicMuteWorkerEnrollment'
New-Item -ItemType Directory -Path $container -ErrorAction Stop | Out-Null
icacls $container /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F'
if ($LASTEXITCODE -ne 0) { throw 'Could not protect enrollment directory' }
icacls $container /setowner '*S-1-5-32-544'
if ($LASTEXITCODE -ne 0) { throw 'Could not set enrollment directory owner' }
$stage = Join-Path $container 'installation'
New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
icacls $stage /setowner '*S-1-5-32-544'
if ($LASTEXITCODE -ne 0) { throw 'Could not set staging directory owner' }
$code = Read-Host 'One-use enrollment code' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($code)
try {
  $text = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  [IO.File]::WriteAllText((Join-Path $stage 'enrollment.credential'), $text)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $text = $null
  $code.Dispose()
}
mw install --backend-url https://api.music-mute.com --enrollment-file "$stage\enrollment.credential" --output $stage --label "Studio Windows"
mw start --wait-ready
mw status
```

The enrollment directory contains private pairing state; do not share it or add
it to source control. Keep the computer powered on and awake with network access.
The service runs without an open terminal or Windows sign-in. Use `mw drain`
before planned maintenance and `mw resume` when ready to accept work again.

## macOS per-user CLI and LaunchAgent

The public MVP entry point is a current-user install with no `sudo`:

```bash
npm install -g @music-mute/worker
mw install --label "Studio Mac"
```

The package installs `mw` as its CLI command.

Registry installation requires publication first. During the candidate period,
install `@music-mute/worker@next` after that tag is published. Use an Apple Silicon
Mac, Node.js >=24.18.0 <25 and a user-writable npm prefix. pnpm is a development
tool, not an end-user requirement; Python and FFmpeg come with the private runtime.
Minimum supported macOS/RAM and clean-machine acceptance must be recorded for
the final runtime; qualification does not imply support for untested hardware.
An administrator creates the one-use code in Workers → Enrollment in the dashboard.
Public availability of the CLI does not grant admission to the fleet.

`mw --version [--json]` reports the CLI and installed runtime versions separately
without model loading or network access. Upgrade the CLI with
`npm install -g @music-mute/worker@next` during the candidate period (`@latest`
after stable release). Run `mw update --check` and `mw update` separately for
the managed runtime. Both updates are manual. Removing the npm package alone
does not stop or uninstall the LaunchAgent.

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
capacity approval before qualification. For each canonical recipe it measures a
single-worker baseline followed by two independent processes, with cold and warmup
runs excluded from throughput. A seven-day private approval contains every measured
run and output comparison. Startup recomputes each recipe's 1.1x throughput and
quality gates, verifies the installed release inventory, executable paths, model,
fixture, recipe set and host/OS identity. Windows approval also binds the DXGI
adapter hardware and driver version. Old summary-only approvals require a fresh
benchmark; there is no conversion or compatibility bypass.

After qualification, `mw capacity --workers 2` atomically configures two slots while
the service is stopped. Repeating the command preserves their IDs. It does not
start the service or change backend policy. `mw capacity --workers 1` restores
one slot even if approval has expired. Both platforms still require the existing
backend-approved machine capability and policy. Qualification on a short fixture
does not establish sustained workload capacity.
An administrator with `workers.manage` can approve the backend ceiling from the
machine's **Approve two workers** capability action after reviewing the installed
machine's passing qualification. Record the benchmark evidence in the required
reason and complete fresh authentication. This approval does not start the local
service: configure capacity while stopped, then resume and start with
`--wait-ready`, and verify both slots in the live dashboard.
`update --check` verifies signed metadata
without minting a download grant or changing local state. `update` downloads a
verified candidate, checks the private Node/FFmpeg versions, qualifies MPS,
switches the release pointer atomically, restores whether the agent was running,
and, for a running service, runs the packaged
runtime doctor, and restores the known-good release if either startup or the
doctor fails. Failed candidates are locally quarantined. Two-worker installations transition
to one worker per GPU until the candidate is separately qualified. The updater
journals the previous configuration and restores it on rollback, leaving the old
capacity receipt intact. Stopped installations also undergo configuration validation.
An expired capacity receipt blocks two-worker admission but does not block update
checks. Successful activation does not promise automatic rollback for later crashes;
the persisted restart budget may require operator recovery. Mutating CLI commands
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

`mw install [--json]` without enrollment flags verifies a preserved paired
installation and reactivates its immutable release. It validates the exact
runtime/state paths, private ACLs, release inventory and any two-worker capacity
receipt before registration. A registered installation returns `already-installed`
without starting a stopped service. Reactivation preserves credentials and
lifecycle intent; registration/startup failures restore the previous local files
through the native recovery journal. The installed release must contain the
current manager and `config-check` command. The source implementation and native
filesystem rollback tests are complete; acceptance through a newly packaged
release remains tracked in the implementation ledger.

`mw update --check [--json]` requests Windows metadata without a download grant.
The shared macOS/Windows verifier checks Ed25519 signatures, target platform,
archive content type, expiry and the protected sequence/quarantine state. Windows
trust and update state reside under the administrator-controlled `service`
directory. This check does not download or switch the installed runtime.

`mw update [--force] [--json]` downloads the signed ZIP into a private transaction,
checks the archive and release inventory, then rechecks the signature and original
pairing/configuration under the native operation locks. It qualifies the new
release as LocalService and preserves running/stopped state and lifecycle intent.
Changed releases use one worker until a fresh two-worker benchmark authorizes
the second slot. Graceful drain acknowledgement precedes the maintenance
transaction. The transaction journals config, credentials, the original lifecycle
intent, activation files and update sequence before activation; failed or
interrupted activation restores the previous release and quarantines the failed
candidate. The protected
sequence advances only with a committed activation. Native acceptance and its
fixture boundaries are recorded in the implementation ledger.

Maintenance also journals Windows' actual service startup and recovery settings.
It disables SCM restarts while qualifying a release, waits out any previously
queued restart delay, then restores those settings. Replacing the WinSW XML
alone does not update an existing SCM registration. The managed policy supports
no-action/restart entries with delays up to one minute; other custom recovery
actions are rejected before maintenance changes the service.

The current Windows CLI routes `start`, `stop`, `restart`, `pause`, `drain`,
`resume` and local `status` to the native Service Control Manager. Run operator
commands from an elevated administrator shell. Repeated start/resume preserve
an already-running worker. Graceful stop waits for the shared runtime to
acknowledge drain and finish active attempts; `--force` explicitly allows
interruption. Status rejects records from an earlier service process or a stale
heartbeat. `status --watch` uses the shared interruptible observation loop and
prints newline-delimited snapshots with `--json`. `start --wait-ready` waits up
to six minutes for the current service's models, reports phase changes and
preserves the running service if waiting times out. This local readiness check
does not override pause/drain intent or establish backend claim eligibility.

`logs`, `job`, `errors`, `explain` and `perf` use the same bounded, sanitized
operator implementation as macOS. Windows checks the private installation ACLs
before reading this history. Installer operations and mutating CLI operations
share an exclusive kernel-owned named-pipe lock, including owner-death recovery.

`unpair [--force] [--json]` drains and stops local processing, requests the
existing authenticated backend unpair command, and verifies the returned
machine identity. It preserves credentials on rejection or mismatch. Once
confirmed, it records an administrator-controlled receipt before removing the
credential and runtime configuration. A retry completes interrupted cleanup
without another backend request; a receipt for a different pairing is rejected.
`--force` permits interrupting active processing. Graceful backend conflicts
are retried within a bounded monotonic deadline.

`uninstall [--json]` drains/stops processing and removes the SCM registration,
stable service files and active-release marker. Releases, models, credentials,
configuration, diagnostics and history are preserved. `uninstall --purge`
requires a valid backend-confirmed unpair receipt and absent credential/config
files. Run purge through Node/CLI outside the managed runtime so Windows does
not have to delete its executing binary. Pending maintenance must be recovered
before either removal command; deleting credential files manually is not proof
of unpairing.

`doctor [--full] [--json]` checks Windows installation ACLs, configuration,
lifecycle, pending recovery, and current service heartbeat. Full mode additionally
verifies the active release inventory before executing its private Python
integrity checker. It checks DirectML availability, the cached model and media
tools without inference or starting the service. A stopped service is reported
as `SERVICE_NOT_RUNNING` with exit 1, while offline integrity checks still run.
Provider availability is separate from LocalService GPU qualification.

`diagnostics [--output <new-archive.zip>] [--job <id>] [--since <duration>]`
uses the same allowlisted contents and 8 MiB export bound as macOS. It writes a
new ZIP under the protected service directory by default; an explicit local absolute
path must have an existing parent and cannot target installation files. The ZIP
is created with access limited to Administrators and SYSTEM before bytes are
written. Existing outputs are never replaced. An interrupted export can leave
an incomplete private output; choose a new filename when retrying. The command
exports local evidence only and does not contact or upload to the backend.

Windows parity work and its native acceptance evidence are tracked in
[the implementation ledger](../docs/worker-windows-macos/IMPLEMENTATION.md).
Windows `benchmark-file` runs as LocalService with a private copy of the input,
one cold run, 0-2 warmup runs and 3-10 measured runs. It requires the operational
service to be stopped and restores its previous stopped definition afterward.
The report identifies the GPU, measured DirectML dispatch, stage timings and
median processing time. Dedicated VRAM capacity is not an allocation measurement.
Use `--release-version` for an installed, staged candidate without enrollment:

```powershell
mw benchmark-file --input C:\MusicMuteBuild\qualification.wav `
  --release-version 0.1.0-win.20260929.14 `
  --recipe kim-vocals-v2 --warmup-runs 1 --measured-runs 3 `
  --output C:\MusicMuteBuild\benchmark.json --json
```

Output must be new and cannot alter installed code or service configuration.
`mw benchmark --workers 2 --input <absolute-audio-path>` runs both canonical
recipes, comparing a single baseline process with two independent processes.
Every process completes its cold and warmup runs before a common measured-run
start. At least three measured runs per process are required. Each recipe must
improve throughput by at least 1.1x and pass decoded-output comparison (maximum
absolute difference 0.01, RMS difference 0.0001, equal frame counts). The report
includes individual process peak resident memory, which excludes GPU allocation
and media subprocesses. A valid measurement can report `FAIL`; this does not
activate a second worker. For an existing stopped installation, a successful run
against its active release and installed `state/qualification-fixture-<sha256>.wav` writes the full
capacity approval. An unpaired installation, another candidate release, or a
different input produces measurement evidence only. Every two-worker rerun
invalidates prior approval before GPU work. Use `mw capacity --workers 2` after
successful approval, then start/resume through the normal lifecycle commands.
Candidate 14 passed native capacity approval, two-slot activation, overlapping
600-second jobs, corruption/cancellation isolation, active drain and repeated stop
against synthetic loopback backend/storage. Its short-fixture throughput gains
were 1.52–1.54x with matching decoded outputs. Boot and two-job processing also
passed without interactive sign-in. Real production backend/S3 acceptance is
separate; see the dated implementation ledger and current readiness report.

The macOS two-worker command uses the same coordinator and validators. Startup,
warmup, report finalization and output comparison are excluded from its measured
throughput. Full measurements are kept in private `state/capacity-measurements.json`;
a failed rerun invalidates the previous capacity receipt.

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
pnpm run package:windows `
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
definition, and rolls back the protected configuration snapshot if qualification
or runtime startup fails. Drain and stop the existing service before maintenance.
The durable journal supports recovery after installer termination; subsequent
manager operations recover it before making further changes. For explicit recovery,
run `mw recover --json`. Recovery uses the journal's verified installed manager
when an update interrupted the active release switch. Use `--leave-stopped` when
the restored runtime needs offline repair or capacity requalification before it
can start. If the first installation was interrupted before an active
release was recorded, supply `--release-version <installed-version>`. This command
verifies the installed package and uses its manager to recover the private journal.
The packaged manager also supports `-Action Recover` with the same `-InstallRoot`.
Normal lifecycle commands reject a pending recovery journal. Full service crash
and reboot acceptance remain tracked separately in the implementation ledger. The
runtime config must select one or two qualified DirectML slots on adapter `0` and use the
matching versioned runtime paths plus the stable state paths.

```powershell
powershell.exe -NoProfile -File C:\MusicMuteBuild\musicmute-worker-0.1.0-win\installer\manage-windows-service.ps1 `
  -Action Install `
  -Release C:\MusicMuteBuild\musicmute-worker-0.1.0-win `
  -Config C:\MusicMutePrivate\runtime.json `
  -Credential C:\MusicMutePrivate\machine.credential `
  -ModelSource C:\MusicMutePrivate\Kim_Vocal_2.onnx `
  -FixtureSource C:\MusicMutePrivate\qualification.wav `
  -FixtureSha256 <verified-fixture-sha256>

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
Native stopped-service reset, preserved bytes/ACL, repeated reset and restoration
passed on candidate 14; see the dated implementation ledger.

`Repair` accepts the same private inputs as `Install`. Both accept `-LeaveStopped`
for maintenance that must qualify the candidate without starting operational
processing afterward. `Uninstall` drains active work, suppresses queued crash
restarts and waits for SCM deletion before removing the stable wrapper and
active-release marker. Graceful drain acknowledgement precedes the removal or
update transaction, so a rejected or interrupted drain leaves active work alone.
Once that transaction starts, recovery restores a stopped installation for
removal; updates retain the prior lifecycle intent in their verified snapshot. Releases,
credentials, models and job state remain preserved. The scripts never bypass
PowerShell policy, alter global Node/Python, or install/replace a GPU driver.
Candidate `0.1.0-win.20260929.3` passed native Z440 LocalService qualification
for both current recipes, including accelerated DirectML dispatch with no CPU
node events. See the ledger for artifact identity and limits. Later source
changes still require a new package. Logged-out/reboot recovery, live S3 and
two-worker acceptance remain open; package or fixture tests do not prove them.

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
recipe revision 6: separate to WAV, optionally trim WAV, encode one final 160 kbps MP3,
then validate it. Trimming defaults to enabled and can be disabled per job.
The algorithm uses 10 ms louder-channel RMS windows, a strict -40 dBFS threshold, 0.6-second minimum
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
Upgrade workers before enabling revision 6 in the backend. Revision 5 snapshots
remain supported with their original -32 dBFS threshold; revision 4 is not silently
reinterpreted. Historical records retain their original step IDs; no database
rewrite is required.

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

## Telemetry and privacy

Packaged runtimes enable the existing Sentry CLI/engine error reporters by default.
The reporters sanitize diagnostic data and do not intentionally send source media,
credentials, signed URLs or personal filesystem paths. Backend diagnostic forwarding
is a separate authenticated channel. Neither local capture nor an HTTP response
alone establishes operator-visible delivery. See the release acceptance checklist.
The `MUSICMUTE_SENTRY_ENABLED=false` service environment disables Sentry; setting it
only in an interactive shell does not change an already-installed LaunchAgent.

## Optional silence trimming (2026-09-26)

`POST /jobs` and `POST /media-imports` accept the optional JSON boolean
`trim_enabled` (default `true`). Set it to `false` to keep quiet sections and the
full separated-audio timeline for future video synchronization. This still removes
music and encodes MP3; encoder delay/padding must be handled by the future muxer.
The choice is immutable per job and is preserved by retries. Changing it with an
existing `request_id` conflicts; omitted and explicit `true` are equivalent.
Strings and null are rejected. Audio acquisition remains audio-only.

Recipe revision 6 trims at -40 dBFS, with the existing 0.6-second minimum gap,
0.2-second padding and 5 ms fades. Revision 5 queued/retry snapshots retain -32
dBFS. Deploy upgraded workers before the backend creates revision 6 jobs: older
workers reject unknown recipe snapshots. No mobile switch is added in this change.

API preflight: https://opensource.zalando.com/restful-api-guidelines/ read on
2026-09-26; rules 101 (OpenAPI), 104 (security), 106 (compatibility), 118
(snake_case), and 176 (problem responses). Existing auth and errors are preserved.

## Job stage measurements

The runtime measures each attempt stage with a monotonic clock and sends bounded
`execution_timings` snapshots through progress, completion and failure requests.
NestJS retains each attempt and computes queue/retry and end-to-end durations.
Incomplete stages remain last-observed lower bounds after a crash or cancellation.
Deploy backend support before this worker update; see
[server-owned stage timings](../docs/job-stage-timings.md) for boundaries and compatibility.

## Transfer timing breakdown

Successful-attempt diagnostics add `inputGrant`, `outputGrant`, and `outputPut`
to the existing stage timings. `upload` includes its grant/PUT components; do not
sum overlapping measurements. `outputPut` includes failed transfer calls before
successful retry/recovery. See [the measurement and rollout guide](../docs/audio-transfer-performance/README.md).
