# MusicMute worker runtime

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
development. The model is not redistributed by this repository; it must be in
the verified content-addressed cache. Platform service installation and the
remaining host-safety acceptance are checkpoints D4-D6. Passing local tests
does not certify service startup, live S3, or production readiness.

## macOS private release and LaunchDaemon

The macOS packager accepts only a native Darwin ARM64 host and an already
qualified, private runtime. It copies the compiled worker, engine, standalone
Node root, standalone Python root, FFmpeg and FFprobe into a new versioned
directory and writes a complete content/mode/symlink manifest. The Node,
Python and media executables must pass a Mach-O audit: ARM64 code, no mutable
Homebrew or other non-system absolute dependencies, and no external RPATH.
Models, credentials, configuration and job data are never included in the
release.

```bash
pnpm run build
node dist/src/cli/main.js macos package \
  --worker-root /absolute/source/worker \
  --output /absolute/staging/musicmute-worker-0.1.0 \
  --version 0.1.0 \
  --node-root /absolute/private/node \
  --python-root /absolute/private/python \
  --ffmpeg /absolute/private/ffmpeg \
  --ffprobe /absolute/private/ffprobe
```

The Python root must contain `bin/python3` and the exact CoreML lock. The Node
root must contain `bin/node`. Never substitute a Homebrew binary just because
it runs on the build machine; its external library paths make the release
non-private and the packager rejects it.

Installation uses an existing dedicated macOS account and normal administrator
consent. It does not create accounts, collect a password or edit global
Node/Python. The runtime config must point at these stable default paths:

- `/Library/Application Support/MusicMuteWorker/current/app/engine`
- `/Library/Application Support/MusicMuteWorker/current/runtime/python/bin/python3`
- `/Library/Application Support/MusicMuteWorker/current/runtime/bin/ffmpeg`
- `/Library/Application Support/MusicMuteWorker/current/runtime/bin/ffprobe`
- `/Library/Application Support/MusicMuteWorker/state/{attempts,models}`
- `/Library/Application Support/MusicMuteWorker/state/machine.credential`

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
