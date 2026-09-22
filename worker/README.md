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
Python child owns local media preparation, inference and result metadata. Audio
bytes never travel through the child control pipe, and the child never receives
backend or S3 credentials.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
uv venv .venv --python 3.13
uv pip sync --python .venv/bin/python ../tools/worker-gpu-feasibility/requirements-mps-base.lock.txt
uv pip install --python .venv/bin/python --no-deps \
  -r ../tools/worker-gpu-feasibility/requirements-mps-overlay.lock.txt
pnpm run verify
```

On Windows, create the venv with the accepted Python 3.12 runtime and sync
`requirements-directml.lock.txt` instead. `MUSICMUTE_PYTHON` may point the test
runner at an already-qualified interpreter. Do not mix ONNX Runtime
distributions or install these locks globally.

The separate MPS overlay intentionally uses `--no-deps`: the MPS base lock
already supplies the `onnx` module through `onnx-weekly`, while upstream
`onnx2pytorch` declares the stable `onnx` distribution. Installing both would
make the packaged module namespace order-dependent.

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
musicmute-worker run --config /absolute/path/runtime.json
```

```json
{
  "schemaVersion": 1,
  "backendBaseUrl": "https://api.example.invalid/api/v1",
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
root. Records are capped at 8 KiB, the spool is capped at 8 MiB and signed URLs,
secret-like fields and user-home components are redacted before persistence.
If resource probes or the spool fail, new claims stop instead of treating
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
musicmute-worker install --label "Studio Mac"
```

The command reads the one-use enrollment code from `/dev/tty` with echo
disabled, uses `https://api.music-mute.com/api/v1`, downloads the service
runtime beside any active release, verifies it, runs MPS qualification, and
then installs `~/Library/LaunchAgents/com.musicmute.worker.plist`. The
LaunchAgent always runs MusicMute's immutable private Node/Python/FFmpeg
runtime; it never mutates Homebrew, MacPorts, `/usr/local`, or the npm prefix.
If installation is interrupted, rerunning the same command reuses the protected
transaction credential instead of requesting another one-use code. After a
conservative `uninstall`, running `musicmute-worker install` with no flags
verifies and reactivates the preserved paired release without enrollment or a
network download. A failed recovery removes the activation pointer again.

If an old one-use code was already consumed by a different exchange, create a
new code in the dashboard and run `musicmute-worker install --label "Studio Mac"
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
be already drained and stopped. `benchmark --workers 2` first records the
single-worker baseline, then runs two isolated MPS qualifications
concurrently. It writes an owner-only, seven-day capacity receipt only when
both accelerated runs preserve the model/release/fixture identity and improve
throughput by at least 1.1x. Runtime configuration defaults to one worker per
GPU, requires that fresh receipt to select two, and rejects more than two;
backend-approved machine capability and policy remain additional hard gates.
`update --check` verifies signed metadata
without minting a download grant or changing local state. `update` downloads a
verified candidate, checks the private Node/FFmpeg versions, qualifies MPS,
switches the release pointer atomically, starts the agent, runs the packaged
runtime doctor, and restores the known-good release if either startup or the
doctor fails. Failed candidates are locally quarantined. Mutating CLI commands
hold an owner-only process lock; a concurrent operation fails without changing
state, and a lock left by a dead process is recovered safely. `uninstall`
preserves state by default; `uninstall --purge` requires a backend-confirmed
`unpair` receipt first. Missing or manually deleted credential/config files are
not accepted as proof of unpairing.

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
keeping five gzip archives per stream. The structured diagnostic spool remains
hard-capped at 8 MiB and stops new claims if durable diagnostics become unsafe.

```bash
musicmute-worker logs
musicmute-worker logs --events --since 2h
musicmute-worker logs --errors --attempt-id <attempt-uuid>
musicmute-worker logs --events --level error --follow
musicmute-worker logs --clear
musicmute-worker diagnostics
```

`logs` shows readable stdout/stderr by default. Structured views accept
`--attempt-id`, `--since` (`s`, `m`, `h`, or `d`, up to 30 days), and
`--level info|warning|error`; scripts may add `--json` except while following.
`status` includes the runtime heartbeat, child state, current and last jobs,
spool state, and total log disk use.

`logs --clear` is the explicit destructive maintenance command. If the
LaunchAgent is loaded, it drains active work, stops the service, truncates the
active stdout/stderr streams, removes their five known archive generations,
resets the structured event spool, and starts the service again. It preserves
configuration, credentials, models, job files, diagnostic ZIP exports, and
unrecognized files. Use `--force` only to bypass a drain that cannot complete;
add `--json` for automation.

`diagnostics` creates an owner-only ZIP in `~/Downloads`, or at an absolute
path inside the current home supplied with `--output`. It contains sanitized
status, Doctor results, recent events/errors, and configuration field names
only. It never includes credentials, configuration values, media, models,
signed URLs, or unredacted user paths. These commands never request `sudo`.

`status` combines protected local lifecycle/runtime state with the read-only
machine-authenticated `GET /api/v1/worker/v1/status` response. It reports the
dashboard machine status, policy revision, last contact, active-attempt count,
and effective claim permission. If the backend is offline, remote state is
explicitly unavailable and the command returns an unhealthy exit instead of
guessing that local `resume` overrides dashboard authority.

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
musicmute-worker package-macos \
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

`Repair` accepts the same four private inputs. `Uninstall` removes only the
Windows Service definition, stable wrapper and active-release marker; releases,
credentials, models and job state remain preserved. The scripts never bypass
PowerShell policy, alter global Node/Python, or install/replace a GPU driver.
Local package tests do not prove LocalService GPU access, logged-out operation,
restart/reboot recovery, live S3, or actual Z440 execution; those stay `NOT_RUN`
until the owner-authorized Windows host run.

### Offline song benchmark (macOS)

With the worker already drained and stopped, benchmark the packaged UVR-compatible MPS engine directly. This command does not contact the backend, S3, or a database. Each invocation runs one selected Kim Vocal 2 recipe pass:

```sh
musicmute-worker benchmark-file --input /absolute/path/song.mp3 --recipe kim-vocals-v2-trim --iterations 2 --json
```

The command preloads the model once, then runs exactly one full song pass. The report separates model preload, one-pass latency and combined cold latency, with per-stage timings for preparation, separation, optional reference-compatible gap trimming, 320 kbps MP3 encoding and validation. Production children preload the verified model before announcing readiness and keep it resident between jobs; their bounded startup timeout covers the private Python import and PyTorch MPS initialization. Kim Vocal 2 uses UVR's `onnx2pytorch` MPS path, segment size 256, batch size 1, denoise disabled, and model-specific **Default** overlap. Use `--json` for machine-readable output.

The worker advertises `kim-vocals-v2` for an untrimmed vocal stem and `kim-vocals-v2-trim` for the default product behavior. The trimmed recipe preserves the reference `separate.py` algorithm: 10 ms louder-channel RMS windows, a strict -45 dBFS threshold, 0.8-second minimum gaps, 0.2-second retained padding, 5 ms boundary fades, and all-silent preservation. CoreML, denoise recipe variants, and multi-iteration file benchmarks remain outside this local-development contract.
