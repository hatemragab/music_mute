# D runtime evidence

Observed 2026-09-19 in Africa/Cairo on `codex/worker-runtime`, created from the
accepted control-plane collection commit
`1cd22912dd93363b45f556951555c16d9ba6e796`. The D1 local environment was
Darwin 25.6 ARM64 with Node.js 24.18.0, pnpm 10.14.0 and Python 3.14.4.

## Checkpoint status

| Checkpoint                        | Status  | Evidence                                                                                                                                                                                                         |
| --------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 supervisor and child protocol  | PASS    | Standalone worker package, generated backend protocol copy, bounded framed TypeScript/Python IPC, lifecycle/timeouts/cancellation and focused verification.                                                      |
| D2 versioned Kim recipes          | PASS    | Four immutable recipes, model/media validation, safe ordered pipeline, reference trimmer parity, real FFmpeg option coverage and a real framed M4/CoreML Kim-to-MP3 run.                                         |
| D3 runtime ownership and recovery | PASS    | Authoritative HTTPS reconciliation, fenced leases/cancellation, safe exact transfers, lost-response recovery, restart cleanup and a complete local HTTP runtime integration path.                                |
| D4 Mac service                    | BLOCKED | Private release/service tooling and real private-Python CoreML execution pass, but no portable FFmpeg package, enrolled machine config/credential or authorized system LaunchDaemon acceptance is available yet. |
| D5 Windows service                | NOT_RUN | No Windows service was installed or tested.                                                                                                                                                                      |
| D6 safety and adapters            | NOT_RUN | Full runtime safety, provider and platform adapter acceptance remains.                                                                                                                                           |

## D1 supervisor and child protocol

- Created a new component-owned `worker/` package using the repository's pinned
  Node.js 24 and pnpm 10 ranges. It does not alter backend or dashboard package
  ownership.
- The backend pure-data protocol remains canonical. A deterministic script
  copies it into the worker package, records the source SHA-256 digest and makes
  verification fail if the committed copy drifts.
- Added a 64 KiB big-endian length-prefixed JSON protocol shared by TypeScript
  and Python. Both sides reject unknown envelope fields, unsupported versions,
  invalid UUID-v4 request/incarnation values, noncanonical timestamps,
  excessive nesting/items/strings, invalid JSON and incomplete/oversized
  frames.
- The supervisor starts one initial child per unique GPU, waits for a bounded
  ready handshake, correlates terminal responses by request ID, provides
  cancellation, kills timed-out children and shuts them down cleanly.
- Child processes inherit only basic platform variables plus two explicit
  non-secret MusicMute keys. Backend/S3 credentials are not accepted. Stderr is
  sanitized and retained only as a bounded tail.
- At the D1 checkpoint, the Python child answered protocol health checks and
  explicitly returned `PROCESSING_NOT_IMPLEMENTED`. D2 replaced that guard with
  the validated pipeline below.

## Verification

From `worker/`:

```bash
pnpm run verify
node dist/src/cli/main.js protocol-doctor
```

Result: PASS.

- backend protocol source-digest check: PASS
- formatting: PASS
- lint: PASS, zero warnings and errors
- TypeScript typecheck: PASS
- TypeScript tests: PASS, 3 files and 10 tests
- Python IPC tests: PASS, 4 tests
- TypeScript production build: PASS
- built CLI to real Python-child handshake: PASS

The tests cover fragmented/consecutive frames, size/depth/field rejection,
cross-language startup and ping, explicit unavailable processing, cancellation,
request timeout/forced stop, stderr redaction, environment rejection and
one-child-per-GPU capacity.

## D2 versioned Kim recipe family

- Frozen exactly four recipes: `kim-vocals-v1`, `kim-vocals-trim-v1`,
  `kim-vocals-denoise-v1` and `kim-vocals-denoise-trim-v1`. Disabled steps are
  absent from the ordered step list and execution timings rather than simulated
  with no-op parameters. `kim-vocals-trim-v1` remains the initial default.
- The backend and Python runtime independently derive the same canonical
  SHA-256 recipe digests. A child rejects unknown fields, unknown recipes or any
  mismatch in the model, step, trim, denoise, preparation or encoding snapshot.
- The model cache is keyed by the qualified artifact digest. Installation and
  every child configuration validate `Kim_Vocal_2.onnx` as 66,759,214 bytes
  with SHA-256
  `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
  The model remains excluded from Git and its redistribution status remains
  unresolved.
- Media commands use absolute executable paths, argument arrays, no shell and
  a local-only FFmpeg protocol allowlist. The fixed order is input identity and
  decoded-media validation, PCM16 stereo 44.1 kHz preparation, Kim vocal-only
  FLAC separation, optional `afftdn-conservative-v1`, optional
  `trim-vocal-gaps-v1`, 192 kbps MP3 encoding, then final probe/size/hash.
- The trimmer port matches the preserved source's eight synthetic sample-count
  vectors and produces byte-identical PCM16 output for the internal-gap parity
  case, including partial frames, louder-channel RMS, padding, fades, rounding
  and all-silent fallback. Retained ranges are reported in bounded chunks.
- Four-recipe pipeline tests use real FFmpeg/ffprobe with a deterministic fake
  separator so both enabled and genuinely omitted denoise/trim paths run. A
  warm pipeline reuses one separator without cross-attempt output reuse.

### Real M4/CoreML child run

The accepted native ARM64 Python 3.13.7 environment, qualified model and owned
8-second fixture (`dd1c139a6353ba06075a4216b3e83ac8ae8ddc0601c434105dcece5486bf28c1`)
were used through the built TypeScript supervisor child wrapper and framed
Python process command. Result: PASS.

- child advertised exactly the four recipe IDs and returned a terminal result;
- output existed as `audio/mpeg`, 193,767 bytes, stereo 44.1 kHz and 8.0 seconds;
- source/output were 352,800 samples, with one identity edit range because this
  fixture's separated vocal stem had no qualifying gap;
- recipe digest was
  `1a70379331fafb360f4cd388e17f4c6ce511031e4082f34ba63676957d8c34c3`;
- executed stages were model validation/load, input identity, media validation,
  preparation, separation, trim, encode and output validation;
- third-party progress text initially corrupted stdout framing. The child now
  reserves a duplicate protocol descriptor and redirects Python/native stdout
  to bounded sanitized stderr; a focused subprocess regression test covers it.

The earlier B2 profile remains the evidence that this exact lock/model dispatches
the Kim graph to CoreML. D2 did not create a new ONNX Runtime provider profile.
The synthetic run proves execution and output structure, not listening quality.

### D2 verification

- worker formatter/lint/typecheck/build: PASS;
- TypeScript worker tests: PASS, 3 files and 10 tests;
- Python engine tests: PASS, 13 tests, including all four recipes and trimmer
  parity;
- backend D2-focused tests: PASS, 10 files and 42 tests;
- backend formatter, lint, typecheck and production build: PASS;
- backend unit tests: PASS, 108 files and 729 tests. Because Vitest imports
  this checkout's developer `.env.local` as strings, 107 files/727 tests ran
  in an env-file-free temporary copy and the two repository-root packaging
  tests ran in the original checkout; no environment file was changed;
- backend E2E tests: PASS, 22 files and 135 tests in the same env-file-free
  temporary copy;
- real framed M4/CoreML child pipeline: PASS.

## D3 runtime ownership and recovery

- Added the runnable TypeScript control-plane client and runtime loop. A boot
  opens one machine session, reconciles and acknowledges the current policy,
  registers stable slots and claims only idle eligible slots. An uncertain
  claim keeps the same request ID across bounded transport retries so a lost
  response cannot claim another job.
- HTTPS/MongoDB responses remain authoritative. Idle reconciliation uses the
  accepted randomized 60–120 second window, active slots do not poll for more
  work, and `hintAvailableWork()` is a coalescing acceleration hook only. No
  WebSocket server or hint delivery is claimed in D3.
- Every active attempt renews its exact ownership tuple on the accepted
  20-second cadence. Lease safety uses server-provided durations anchored to
  both monotonic and wall elapsed time; either clock moving beyond the safety
  window stops publication. Expired, cancelled or revoked dispositions abort
  transfers and forcibly terminate an active synchronous Python child before
  the backend authority becomes uncertain.
- Child processes can now be restarted with a new local incarnation after a
  crash, timeout or forced cancellation. A supervisor restart opens a new
  backend session, which fences the previous session. Work never resumes from
  a local checkpoint: stale UUID attempt directories are removed on startup
  and a new backend attempt restarts from its pinned input.
- Added strict bounded response parsing and a machine runtime config whose
  credential is read from a separate non-symlink file. Non-loopback control and
  transfer URLs require HTTPS; redirects are never followed; control responses
  are capped at 64 KiB; attempt input is created exclusively, streamed with an
  exact byte/checksum check and removed on failure.
- Output publication revalidates the local regular-file path, byte count and
  checksum, sends only the three backend-signed PUT headers, requires an S3
  version ID and conditionally completes the same attempt/recipe. Completion
  ambiguity never triggers a contradictory failure publication.
- Closed the lost-PUT-response gap at the existing backend output-grant
  boundary. Replaying the identical frozen output declaration first inspects
  the attempt-scoped key and returns the exact matching immutable version when
  S3 accepted the prior PUT. Otherwise it issues a fresh bounded grant. A
  mismatched object still fails closed.
- The CLI now supports
  `musicmute-worker run --config /absolute/path/runtime.json`, handles graceful
  process signals and emits only bounded structured lifecycle events. D4/D5
  still own creation, permissions and service installation for platform config
  and credential files.

### D3 verification

From `worker/`, `pnpm run verify`: PASS.

- protocol drift, formatting, lint and TypeScript typecheck: PASS;
- TypeScript worker tests: PASS, 9 files and 25 tests;
- Python engine tests: PASS, 13 tests;
- production build and built `protocol-doctor`: PASS;
- local real-HTTP runtime integration: PASS. It exercised session, config,
  slot, claim, exact download, child boundary, signed-header upload and
  completion with real Node HTTP/fetch streams and a deterministic test child;
- recovery coverage: PASS for same-ID lost claim response, lost PUT response,
  cancellation without publication, ambiguous completion, child restart,
  forward wall/sleep safety and stale workspace cleanup;
- backend D3-focused transfer/attempt tests: PASS, 2 files and 13 tests;
- backend format, lint, typecheck and production build: PASS;
- backend unit tests: PASS, 107 files and 729 tests in an env-file-free
  temporary copy, plus the 1 repository-root packaging file and its 2 tests in
  the original checkout;
- backend E2E tests: PASS, 22 files and 135 tests in the env-file-free copy.

The HTTP integration deliberately used a loopback transfer fixture, not live
S3, and its deterministic child is `SIMULATED` engine evidence. D2 separately
proves the real framed M4/CoreML child pipeline. No combined live backend, S3
and CoreML job was claimed at D3.

## D4 Mac runtime and service installation (in progress)

- Added a deterministic native ARM64 release builder. It packages only the
  compiled worker, engine and supplied private Node/Python/FFmpeg/FFprobe
  roots; credentials, configuration, model weights, job data and logs remain
  outside the immutable release.
- Added a reproducible native media-runtime builder pinned to FFmpeg 8.0.3 and
  LAME 3.100. It verifies both source SHA-256 digests, the official FFmpeg GPG
  signature and signer fingerprint, builds static LAME support, disables
  network protocols, and records source/license provenance in the release.
- A complete release manifest records ordered directories, regular-file bytes,
  modes and SHA-256 hashes plus bounded internal symlinks. Verification rejects
  traversal/absolute links, special files, writable release entries, content
  drift and replacement of an installed version with different bytes.
- Every runtime executable must contain ARM64 code and pass an `otool`
  dependency and RPATH audit. System libraries and loader-relative private
  libraries are accepted; Homebrew and other mutable absolute prefixes are
  rejected. The installed Homebrew Node and FFmpeg on this host therefore
  cannot be misrepresented as private package inputs.
- Added idempotent install/repair commands, a dedicated-account system
  LaunchDaemon definition, `0700` state/log roots, `0600` config/credential
  files, atomic `current` activation, previous-release rollback, service
  restart and a doctor path. The LaunchDaemon receives only minimal system
  environment keys and stable private paths; no backend infrastructure or S3
  credential is placed in the plist.
- Python bytecode, Numba and plotting caches are redirected to protected state
  paths. A real packaged doctor and CoreML processing run left all 33,798
  release-manifest entries unchanged.
- Model provisioning accepts only the exact qualified source file, installs it
  into the service account's content-addressed cache and checks the sanitized
  result. Default uninstall removes only the service plist/current pointer and
  preserves releases, model, credential and state for explicitly authorized
  recovery/deletion.

### Real private-runtime evidence

On the actual Apple M4 Pro, a standalone Python 3.13.7 installation was created
under a temporary private root and populated from the frozen CoreML lock
without modifying global Python. It reported `audio-separator==0.47.0`,
`onnxruntime==1.30.0` and CoreML availability. The qualified local Kim artifact
matched 66,759,214 bytes and SHA-256
`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.

The standalone runtime produced a valid 193,767-byte stereo 44.1 kHz MP3 from
the owned eight-second fixture through `kim-vocals-trim-v1`. A separate ONNX
Runtime profile assigned all six model node events to
`CoreMLExecutionProvider` (1,114,292 profiled microseconds) and no node event to
the CPU provider. Result: PASS for the private Python/model/CoreML boundary.

The official Node 24.18.0 Darwin ARM64 archive matched its published SHA-256 and
both that Node binary and the standalone Python executable passed the private
Mach-O audit. The reproducible native media build produced network-disabled
FFmpeg/FFprobe 8.0.3 with statically linked LAME 3.100 and only Apple system
dynamic dependencies; the host's Homebrew FFmpeg remains correctly rejected.

A complete 33,798-entry private release then passed manifest verification and
the packaged runtime doctor. Using only the packaged Python and media binaries,
`kim-vocals-denoise-trim-v1` produced a valid 193,767-byte MP3 with two channels,
44.1 kHz sample rate and 192 kb/s bitrate. A second manifest verification after
processing passed, proving runtime caches did not mutate the release.

### D4 verification and current blocker

- macOS release/manifest/Mach-O/LaunchDaemon/installation tests: PASS;
- full worker protocol drift, formatting, lint, typecheck and build: PASS;
- complete TypeScript worker suite: PASS, 20 files and 49 tests;
- complete Python engine suite: PASS, 21 tests;
- real private Python CoreML provider profile and Kim pipeline: PASS;
- reproducible offline FFmpeg/LAME build and complete private release: PASS;
- packaged runtime doctor, real CoreML job and post-run immutability: PASS;
- enrolled config/credential, system LaunchDaemon install/restart, dedicated
  logged-out operation, live backend/S3 job and reboot: NOT_RUN.

Normal administrator consent, a pre-existing dedicated account and an enrolled
machine config/credential are required for system acceptance. No administrator
password was collected or embedded, and no logout/reboot was attempted. D4
remains unchecked until the real LaunchDaemon flow passes; portable package and
local execution evidence alone are not a completed service checkpoint.

## D5 Windows runtime and service installation (in progress)

- Added a native Windows x86_64 release builder and immutable manifest. It
  accepts only prepared private Node, Python 3.12/DirectML, offline media and
  service-wrapper roots; rejects links; verifies every file by byte count and
  SHA-256; and PE-audits Node, Python, FFmpeg, FFprobe and the service wrapper as
  x86_64 PE32+ executables.
- Pinned the stable WinSW 2.12.0 x64 wrapper. Its official 18,243,033-byte
  release asset matched SHA-256
  `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`,
  and its official license matched its independently pinned digest. The
  PowerShell source builder fails closed on either mismatch.
- Added a password-free WinSW definition using `LocalService`, absolute private
  runtime paths, minimal environment, protected cache/temp roots, automatic
  delayed start, bounded rolling logs and bounded restart policy.
- Added one elevated PowerShell install/repair/doctor/uninstall entry point. It
  serializes installers, validates the immutable release and exact one-slot
  DirectML adapter-0 config, applies SID-based ACLs, installs the exact Kim
  artifact, keeps releases versioned, and restores the prior service definition
  when candidate diagnostics fail. Uninstall preserves releases, credentials,
  models and job state.
- Generalized the private runtime doctor without weakening macOS checks. The
  Windows path accepts only Windows x86_64, Python 3.12,
  `onnxruntime-directml==1.24.4`, `audio-separator==0.47.0`,
  `DmlExecutionProvider`, the exact model and the offline FFmpeg capability set;
  conflicting ONNX Runtime distributions fail closed.

### D5 verification and current blocker

- Windows PE/manifest/builder/service-definition/PowerShell fixture tests:
  PASS, 5 files and 10 tests;
- full worker protocol drift, formatting, lint, typecheck and build: PASS;
- complete TypeScript worker suite: PASS, 20 files and 49 tests;
- complete Python engine suite, including accepted DirectML host selection:
  PASS, 21 tests;
- WinSW official asset/license download and pinned digest comparison: PASS;
- native PowerShell parsing and execution: NOT_RUN on this macOS host;
- complete private Windows package, restrictive ACL inspection, LocalService
  DirectML access, exact RX 580 selection, real inference, restart/logged-out
  behavior, live backend/S3 job, rollback and reboot: NOT_RUN.

D5 remains unchecked. The code and cross-platform fixtures are implementation
evidence only; owner-authorized access to the accepted Windows host and a fully
prepared private Windows runtime are still required for service acceptance.

## Limits

This is local protocol/pipeline/runtime evidence. It does not prove live S3 or
deployed-backend integration, WebSocket hints, accepted-platform service
accounts, installation, logged-out behavior, reboot survival, DirectML service
execution, denoise listening quality or release readiness. The D4 portable Mac
runtime is qualified locally, but its LaunchDaemon acceptance is not. D5 tooling
has only fixture/static evidence; no Windows package or service result is
claimed.
