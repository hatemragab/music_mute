# MusicMute worker runtime

> **macOS per-user MVP implementation:** the no-admin installer, logged-in-user
> LaunchAgent, lifecycle commands, direct-owner model download, signed manual
> updater, rollback, and self-unpair paths are implemented on this branch. The
> older `_musicmute` system LaunchDaemon tooling remains below only for legacy
> migration and compatibility until its separately controlled removal. See
> [`docs/worker-rebuild/architecture/08-macos-user-launchagent.md`](../docs/worker-rebuild/architecture/08-macos-user-launchagent.md)
> for the approved design and migration boundary.

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
uv pip sync --python .venv/bin/python ../tools/worker-gpu-feasibility/requirements-coreml.lock.txt
pnpm run verify
```

On Windows, create the venv with the accepted Python 3.12 runtime and sync
`requirements-directml.lock.txt` instead. `MUSICMUTE_PYTHON` may point the test
runner at an already-qualified interpreter. Do not mix ONNX Runtime
distributions or install these locks globally.

The generated TypeScript protocol under `protocol/v1/` is copied from the
backend's canonical pure-data protocol. Run `pnpm protocol:sync` after an
intentional backend protocol change. `pnpm protocol:check` fails on drift.

Checkpoint D3 adds the authoritative HTTPS runtime loop: machine sessions,
policy acknowledgement, stable slot registration, same-request claim replay,
lease renewal/cancellation, attempt workspaces, exact-version transfers and
idempotent completion/failure. WebSocket work hints may call
`hintAvailableWork()`, but they never replace HTTPS reconciliation or MongoDB
ownership.

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
  "slots": [
    {
      "workerId": "00000000-0000-4000-8000-000000000001",
      "gpuId": "gpu-0",
      "slotIndex": 0,
      "recipeIds": ["kim-vocals-trim-v1"],
      "provider": "coreml"
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

Only two runtime adapters are enabled: native macOS ARM64/CoreML with launchd
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
runtime beside any active release, verifies it, runs CoreML qualification, and
then installs `~/Library/LaunchAgents/com.musicmute.worker.plist`. The
LaunchAgent always runs MusicMute's immutable private Node/Python/FFmpeg
runtime; it never mutates Homebrew, MacPorts, `/usr/local`, or the npm prefix.
If installation is interrupted, rerunning the same command reuses the protected
transaction credential instead of requesting another one-use code. After a
conservative `uninstall`, running `musicmute-worker install` with no flags
verifies and reactivates the preserved paired release without enrollment or a
network download. A failed recovery removes the activation pointer again.

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
be already drained and stopped. `update --check` verifies signed metadata
without minting a download grant or changing local state. `update` downloads a
verified candidate, checks the private Node/FFmpeg versions, qualifies CoreML,
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
temporarily stops the private processing child, runs only the requested frozen
recipe for one to five iterations against the installed qualification fixture,
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

If an older system LaunchDaemon is detected, fresh installation refuses to run
beside it. After draining and revoking that legacy machine, the operator can run
the deliberately hidden administrator helper:

```bash
sudo "$(command -v musicmute-worker)" legacy-cleanup --confirm-backup
```

It targets only `system/com.musicmute.worker`, the exact legacy plist, and the
exact legacy application root. It stops that service and moves the files into a
timestamped root-owned backup; it never deletes the backup or copies the old
machine credential into the user installation.

## Legacy macOS private release and LaunchDaemon

The macOS packager accepts only a native Darwin ARM64 host and an already
qualified, private runtime. It copies the compiled worker, engine, standalone
Node root, standalone Python root and a complete media-runtime root into a new
versioned directory and writes a complete content/mode/symlink manifest. The
Node, Python and media executables must pass a Mach-O audit: ARM64 code, no
mutable Homebrew or other non-system absolute dependencies, and no external
RPATH. Media provenance and LGPL notices are packaged with the binaries.
Models, credentials, configuration and job data are never included in the
release.

```bash
./scripts/build-macos-media-runtime.sh /absolute/private/media-runtime
pnpm run build
node dist/src/cli/main.js macos package \
  --worker-root /absolute/source/worker \
  --output /absolute/staging/musicmute-worker-0.1.0 \
  --version 0.1.0 \
  --node-root /absolute/private/node \
  --python-root /absolute/private/python \
  --media-root /absolute/private/media-runtime
```

The Python root must contain `bin/python3` and the exact CoreML lock. The Node
root must contain `bin/node`. The media builder verifies the official FFmpeg
signature and pinned source hashes, then produces network-disabled FFmpeg
8.0.3 binaries with statically linked LAME 3.100. Never substitute a Homebrew
binary just because it runs on the build machine; its external library paths
make the release non-private and the packager rejects it.

Installation uses an existing dedicated macOS account and normal administrator
consent. It does not create accounts, collect a password or edit global
Node/Python. The runtime config must point at these stable default paths:

- `/Library/Application Support/MusicMuteWorker/current/app/engine`
- `/Library/Application Support/MusicMuteWorker/current/runtime/python/bin/python3`
- `/Library/Application Support/MusicMuteWorker/current/runtime/bin/ffmpeg`
- `/Library/Application Support/MusicMuteWorker/current/runtime/bin/ffprobe`
- `/Library/Application Support/MusicMuteWorker/state/{attempts,cache,models,tmp}`
- `/Library/Application Support/MusicMuteWorker/state/machine.credential`

Python bytecode and library/compiler caches are redirected into the protected
state cache. The immutable release must remain byte-for-byte unchanged after
doctor and processing runs.

```bash
sudo node dist/src/cli/main.js macos install \
  --release /absolute/staging/musicmute-worker-0.1.0 \
  --config /absolute/private/runtime.json \
  --credential /absolute/private/machine.credential \
  --model-source /absolute/private/Kim_Vocal_2.onnx \
  --service-user _musicmute \
  --service-group _musicmute
```

`repair` accepts the same arguments and is idempotent for identical release
bytes. It rejects changing an installed version in place, verifies the exact
Kim artifact before activation, restores the previous `current` release when
activation/diagnostics fail, and then attempts to restart the previous service.
`doctor` validates the manifest, private permissions, config paths, dedicated
account ownership, model hash, CoreML environment and loaded system service:

```bash
sudo node dist/src/cli/main.js macos doctor \
  --service-user _musicmute \
  --service-group _musicmute
```

`uninstall` unloads the LaunchDaemon and removes only its plist and `current`
pointer. Versioned releases, the credential, model cache and job-state root are
preserved for explicit recovery or separately authorized deletion. Automated
fleet updates and destructive state removal are not part of this command.

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
