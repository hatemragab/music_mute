# Portable Windows Worker Bundle — Design

## Goal

Make `windows-worker/` the complete source and setup boundary for a MusicMute
Windows worker. A clean copy of that folder must be enough to prepare a new
Windows machine after the operator has registered a unique worker in the
dashboard and received its one-time raw secret.

This is local, pre-production repository work. It does not create or run a
database migration, change backend data or schemas, register a worker, deploy an
API or dashboard, change CapRover, or update the running Z440 installation.

## Chosen approach

Use a self-contained source bundle with an explicit, repeatable PowerShell
bootstrap. The worker folder owns the separator, pinned Python requirements,
setup/configuration/startup scripts, runtime module, tests, package builder, and
operator documentation. Python and FFmpeg remain explicit machine
prerequisites; the worker setup does not silently install system software or
require administrator access.

Two alternatives were rejected:

- Automatically install Python and FFmpeg with a package manager. This makes the
  first command shorter but changes machine-wide state, may require elevation,
  and depends on an external package identifier remaining stable.
- Keep using a parent/shared virtual environment and copy the separator from the
  backend. This reduces each bundle's size but preserves the cross-folder
  dependencies that prevent reliable worker onboarding.

## Ownership boundary and files

`backend/separate.py` moves to `windows-worker/separate.py`. The backend retains
only server responsibilities: authentication, claims, coordination, durable
queue state, signed transfers, administration, and HTTP contracts. It does not
own or package the Windows audio runtime.

The worker folder will contain:

```text
windows-worker/
  .gitignore
  README.md
  Setup-Worker.ps1
  Configure-Worker.ps1
  Start-Worker.ps1
  Install-Autostart.ps1
  Benchmark-Worker.ps1
  requirements-worker.txt
  worker.config.example.json
  separate.py
  package.py
  musicmute_worker/
  tests/
```

Generated or machine-private material remains excluded: `.venv/`,
`worker.config.json`, `worker-secret.dpapi`, `python.path`, `state/`, bytecode,
build archives, and local benchmark/runtime output. The packaged ZIP uses an
explicit allowlist and never reads a source file from outside `windows-worker/`.

## Dependency contract

`requirements-worker.txt` pins the native versions already validated on the
Z440:

- `audio-separator==0.47.0`
- `onnxruntime-directml==1.24.4`
- `numpy==2.5.3`
- `soundfile==0.14.0`

Python 3.11 or newer and `ffmpeg`/`ffprobe` on `PATH` are prerequisites. The
setup script validates them and stops with direct corrective guidance when they
are missing. It does not modify the global Python installation, PATH, or Windows
package inventory.

The Kim Vocal 2 model is third-party runtime cache data rather than repository
source. Setup prepares it through the installed `audio-separator` library and
proves that it loads with DirectML, without claiming a backend job. The model is
not committed or placed in the source ZIP.

## Setup interface

The normal clean-machine command is:

```powershell
powershell -ExecutionPolicy Bypass -File .\Setup-Worker.ps1
```

`Setup-Worker.ps1`:

1. Requires Windows and resolves a Python 3.11+ base interpreter from an
   explicit `-PythonExe` argument or the Windows Python launcher.
2. Creates or safely reuses `windows-worker\.venv`.
3. Installs exactly `requirements-worker.txt` into that local environment.
4. Validates `ffmpeg` and `ffprobe` without changing the system.
5. Invokes `Configure-Worker.ps1` with the local environment.
6. Collects or accepts a unique worker ID and HTTPS API URL, then requests the
   raw worker secret through a hidden prompt.
7. Runs local dependency checks and explicitly prepares `Kim_Vocal_2.onnx` with
   DirectML without contacting the claim endpoint.
8. Prints the separate autostart and manual-start commands.

Supported setup parameters are `-PythonExe`, `-WorkerId`, `-ApiBaseUrl`,
`-SkipDependencyInstall`, and `-SkipModelPreparation`. The skip switches support
repair and offline workflows; the final check still fails if required runtime
pieces are unavailable. No supported argument accepts a plaintext secret.

## Identity and configuration safety

A clean installation never defaults to `z440`. It requires a valid, unique
worker ID using lowercase letters, digits, and hyphens. This prevents a copied
folder from accidentally impersonating the existing worker.

For an already configured folder, an omitted worker ID or API URL may reuse the
current value after showing it to the operator. Existing installation binding,
active-assignment refusal, machine-wide single-instance exclusion, and DPAPI
secret protection remain unchanged. An explicit `-PythonExe` remains supported
by `Configure-Worker.ps1` for repair and compatibility, but normal setup always
saves the folder-local `.venv` interpreter.

`worker.config.example.json` uses a non-machine-specific valid placeholder. The
setup flow replaces it before normal operation. The raw secret is encrypted with
DPAPI for the current Windows account and is removed from the environment before
separator descendants start.

## Start, prepare, and autostart behavior

`Start-Worker.ps1` retains `-Check`, `-SelfTest`, and `-Once`, and adds
`-Prepare`. Both `-Check` and `-Prepare` are offline with respect to queue claims
and do not require or expose the worker secret. `-Prepare` performs the normal
checks plus loading `Kim_Vocal_2.onnx` through DirectML, so a new machine finds
model/provider failures before its first job.

Autostart remains an explicit second command because Task Scheduler requires the
Windows account password and represents a separate machine-level choice:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Autostart.ps1
Start-ScheduledTask -TaskName 'MusicMute Windows Worker'
```

The current at-boot, signed-out account, single-instance, restart, and ownership
checks remain intact.

## Packaging

`package.py` reads `separate.py`, requirements, setup scripts, worker runtime,
and tests only from its own directory. The archive must contain one top-level
`MusicMuteWindowsWorker/` folder and preserve deterministic sorted paths. It
rejects symlinked source inputs and excludes all configuration, credentials,
state, caches, virtual environments, model data, and generated archives.

Copying either the source folder or the generated ZIP to another Windows machine
therefore carries the same complete setup surface. Each destination still needs
its own dashboard registration, raw secret, local setup, and DPAPI encryption.

## Error handling

Setup stops before configuration when Python, venv creation, dependency install,
FFmpeg, or a required source file is invalid. It stops before any claim when
DirectML or model preparation fails. A failed rerun does not erase an existing
configuration, DPAPI file, installation binding, assignment journal, or state.

Configuration rejects malformed worker IDs, non-HTTPS URLs, URLs not ending in
`/api/v1`, plaintext secrets in arguments, missing example/source files, and
identity/API changes while an assignment is active. Existing worker/runtime
errors remain redacted at the process boundary.

## Testing strategy

Implementation follows red-green-refactor cycles:

- Package tests first require the local separator, pinned requirements, setup
  script, and zero references outside the worker folder.
- Separator tests first require `windows-worker/separate.py` directly with no
  backend fallback.
- PowerShell source-contract tests cover local `.venv` creation, parameter
  forwarding, no `z440` default on clean setup, hidden-secret handling, missing
  prerequisite failures, and no machine/package-manager mutation.
- CLI tests cover `--prepare`, prove it does not create an API client or claim a
  job, and verify model-load failure is sanitized.
- Existing separator parity, process containment, cancellation, transfer,
  recovery, identity, autostart, benchmark, and package tests remain green.
- The generated ZIP is extracted into an isolated temporary directory and its
  tests/package build are run without access to `backend/separate.py`.

macOS/Linux validation can prove source behavior, packaging, syntax, and the
portable setup contract. Native Windows/DirectML execution is a separate proof
and will not be claimed by this local task.

## Acceptance criteria

- `backend/separate.py` no longer exists and no worker source, test, package, or
  documentation reference reads it.
- Every source file required to configure, validate, package, and run a Windows
  worker lives under `windows-worker/`.
- A clean folder requires an explicit unique worker ID and never inherits
  `z440`, another machine's DPAPI secret, configuration, or state.
- The documented setup creates a local virtual environment, installs pinned
  dependencies, validates FFmpeg/FFprobe, configures the worker securely, and can
  prepare the model without claiming a job.
- Packaging succeeds from an isolated copy of only `windows-worker/` and includes
  no private or generated material.
- Existing worker behavior and audio-quality tests pass without changing the
  separation algorithm, model, output format, concurrency, claim lifecycle, or
  backend contracts.
- No database migration, backend schema change, deployment, production
  configuration change, live API call, or remote-worker operation occurs.
