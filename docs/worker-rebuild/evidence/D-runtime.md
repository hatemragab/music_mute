# D runtime evidence

Observed 2026-09-19 in Africa/Cairo on `codex/worker-runtime`, created from the
accepted control-plane collection commit
`1cd22912dd93363b45f556951555c16d9ba6e796`. The D1 local environment was
Darwin 25.6 ARM64 with Node.js 24.18.0, pnpm 10.14.0 and Python 3.14.4.

## Checkpoint status

| Checkpoint                        | Status  | Evidence                                                                                                                                                                                                                   |
| --------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 supervisor and child protocol  | PASS    | Standalone worker package, generated backend protocol copy, bounded framed TypeScript/Python IPC, lifecycle/timeouts/cancellation and focused verification.                                                                |
| D2 versioned Kim recipes          | PASS    | Four immutable recipes, model/media validation, safe ordered pipeline, reference trimmer parity, real FFmpeg option coverage and a real framed M4/CoreML Kim-to-MP3 run.                                                   |
| D3 runtime ownership and recovery | PASS    | Authoritative HTTPS reconciliation, fenced leases/cancellation, safe exact transfers, lost-response recovery, restart cleanup and a complete local HTTP runtime integration path.                                          |
| D4 Mac service                    | BLOCKED | Native package, hidden account, LaunchDaemon, CoreML service-context job and four-recipe installer qualification pass; real fleet enrollment, live backend/S3, logged-out and reboot acceptance remain open.               |
| D5 Windows service                | BLOCKED | Native package, LocalService, ACL, DirectML service-context job, state-preserving rollback and rebuilt-candidate qualification pass; real fleet enrollment, live backend/S3, logged-out and reboot acceptance remain open. |
| D6 safety and adapters            | PASS    | Attempt isolation, trusted paths, resource limits, redaction/spooling, single-job capacity, warm-model isolation and explicit supported adapter boundaries pass local tests.                                               |

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

### Shared enrollment bootstrap

- Added a bounded HTTPS enrollment client and `musicmute-worker enroll`
  command for the accepted C2 exchange/report/activate contract. It reads the
  one-use invitation only from an owner-protected file, rejects non-HTTPS
  endpoints except an explicit loopback-only development mode, and never
  prints installation or machine credentials.
- Request UUIDs and restricted installation state are durably written before
  advancing. Re-running the command reuses the same exchange, report and
  activation identities, validates that returned identities and credentials
  remain stable, and writes `machine.credential` plus non-secret
  `machine.json` into an existing protected directory.
- A real loopback HTTP contract test proves the complete three-request flow,
  protected file modes, secret-free output and a second invocation that
  recovers through backend replay without issuing a second report.
- Runtime-derived enrollment now verifies the immutable release, strictly
  parses the packaged runtime doctor and collects only bounded host/GPU fields
  for the accepted M4/CoreML or RX 580/DirectML pair. It cannot advertise a
  capability from doctor output alone.
- Added a packaged service-identity qualification command. It verifies the
  backend-provided fixture digest, runs all four immutable Kim recipes through
  one warm runtime, profiles ONNX Runtime and emits bounded evidence only when
  the accelerated provider has model-node events and the CPU provider has
  none. Runtime-derived enrollment requires and cross-checks that evidence
  against the host, provider, immutable release-manifest digest and qualified
  model before report/activation.
- Enrollment now exchanges the one-use invitation before expensive local
  report construction, generates and protects the 32-byte machine credential
  locally, and submits only its SHA-256 digest during activation. The backend
  stores that digest, returns no plaintext machine secret and accepts an
  activation replay only when both the request ID and credential digest match.
  This removes the credential-ordering mismatch between restricted
  installation and final native service activation.
- Added a bounded streaming artifact downloader for installation grants.
  It requires HTTPS except for explicit loopback tests, rejects redirects and
  URL credentials, enforces declared size and content type, verifies SHA-256
  while streaming, publishes atomically into an existing protected directory,
  safely reuses an identical file and rejects conflicting local state.
- Added an operator-configured backend catalog and restricted artifact-grant
  route for the platform release, qualified Kim model and rights-cleared
  fixture. The backend validates each pinned S3 object before signing it and
  omits internal storage keys/version IDs from the response. The new
  `prepare-installation` CLI action establishes/replays the installation
  session, downloads that exact set and writes only verified local metadata;
  signed URLs and credentials are not persisted in its artifact receipt. The
  preparation step now also validates every archive path, extracts into a
  protected temporary directory, verifies the immutable platform manifest and
  catalog version, then atomically publishes or safely reuses the versioned
  release root.
- Platform package commands can emit the matching `.tar.gz` or `.zip`
  directly after release verification. Archive publication is exclusive, its
  entry listing is checked with the same path policy, and the command reports
  exact bytes, SHA-256 and content type for catalog registration.
- Closed the fixture-result smoke-test gap. Qualification evidence now binds a
  private service-context Kim output path, byte count and digest to the base
  recipe. Enrollment refuses a changed file, requests one installation-scoped
  immutable PUT, sends only the backend-signed headers and confirms the exact
  S3 version. Activation now requires that durable confirmation. Identical
  retries recover an already uploaded version without a second object, while
  changed reservations or versions fail closed.
- The native installers now provision a digest-named private WAV fixture and
  run that command through a temporary one-shot service definition. macOS uses
  `_musicmute` and CoreML, validates the owner-only report, deactivates the
  qualification LaunchDaemon and atomically restores the normal plist. Windows
  uses `LocalService` and DirectML adapter 0, validates the same strict evidence
  through the packaged CLI, then restores the automatic WinSW definition;
  first installation explicitly reinstalls the service so its SCM start mode
  cannot remain manual. Both paths retain their existing transactional rollback.
- Native installation is now split into qualification and activation. macOS
  `stage` and Windows `Stage` run qualification without fake config or machine
  credentials, never activate the candidate, and restore an accepted prior
  service. Enrollment generates the final one-slot runtime config only after
  activation supplies the real machine ID; a separate native `activate` step
  installs that config and credential before starting the normal service.
- A rebuilt 33,852-entry macOS `0.1.2` candidate passed this stage as
  `_musicmute` across all four CoreML recipes, remained inactive and restored
  the accepted `0.1.1` LaunchDaemon. The first attempt found that the protected
  downloaded model was unreadable to `_musicmute`; staging now makes a private
  service-owned temporary copy for model validation and always removes it.
- The complete worker verification after the latest local installation wiring
  passes protocol drift, formatting, lint, typecheck, 31 TypeScript files/111
  tests, 32 Python tests and the production build. The backend contract change
  passes formatting, lint, typecheck, secret scanning, 110 unit files/749
  tests, 22 E2E files/135 tests and its production build. The shared E2E
  harness also passed five consecutive complete runs after replacing implicit
  test-server lifecycles with an explicit loopback listener. The candidate
  PowerShell script previously parsed with Windows PowerShell on the authorized
  Z440 host; no new native package was built in this revision.
- The complete one-shot installer qualification passed through both native
  service managers with rebuilt `0.1.1` releases. The 33,843-entry macOS
  package ran all four recipes as `_musicmute` through CoreML and restored the
  normal active LaunchDaemon plist. The 31,476-entry Windows package ran all
  four recipes as `LocalService` through DirectML adapter 0, reported 896
  accelerated model-node events with zero CPU model-node events, restored the
  normal WinSW XML and returned the automatic service to `Running`. This is
  native qualification evidence for the two MVP hosts; no real backend
  activation is claimed.
- One-command macOS and Windows bootstrap orchestration now performs artifact
  preparation, native service-context staging, enrollment and activation. The
  Windows path delegates every privileged mutation to the packaged PowerShell
  manager and safely reuses a completed qualification on retry; its final
  install reruns the gate before activation. The orchestration passes local
  contract tests, while a live backend/S3 bootstrap still requires native
  acceptance. Manual prebuilt-report mode remains restricted to explicit
  loopback replay/transport contract testing and is not native qualification
  evidence.

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
- Added idempotent install/repair commands, automatic creation and strict
  validation of the hidden `_musicmute` service account, a dedicated-account
  system LaunchDaemon definition, `0700` state/log roots, `0600`
  config/credential files, atomic `current` activation, previous-release
  rollback, service restart and a doctor path. Activation waits for launchd's
  asynchronous `bootout` completion before bootstrapping the replacement. The
  LaunchDaemon receives only minimal system environment keys and stable private
  paths; no backend infrastructure or S3 credential is placed in the plist.
- The supervisor prepends only the immutable release media directory to the
  child `PATH`, so `audio-separator` finds the same qualified FFmpeg binary that
  the request names explicitly. Relative tool directories are rejected and no
  logged-in shell or global Homebrew installation is required.
- Python bytecode, Numba and plotting caches are redirected to protected state
  paths. A fresh final-D6 packaged doctor and CoreML processing run left all
  33,828 release-manifest entries unchanged.
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

The package was rebuilt again from the final D6 runtime. Its first service-like
run correctly exposed that `audio-separator` performed its own FFmpeg discovery
through `PATH`; a LaunchDaemon does not inherit the interactive Homebrew path.
The supervisor now prepends only the configured immutable media directory to
the child environment. The resulting 33,828-entry package passed the runtime
doctor with CoreML, Python 3.13.7, ONNX Runtime 1.30.0 and the exact Kim model.
`kim-vocals-trim-v1` then produced a valid 193,767-byte stereo 44.1 kHz MP3 at
192 kb/s, and every manifest entry verified unchanged after processing.

### D4 verification and current blocker

- macOS release/manifest/Mach-O/LaunchDaemon/installation tests: PASS;
- full worker protocol drift, formatting, lint, typecheck and build: PASS;
- complete TypeScript worker suite: PASS, 31 files and 111 tests;
- complete Python engine suite: PASS, 32 tests;
- real private Python CoreML provider profile and Kim pipeline: PASS;
- reproducible offline FFmpeg/LAME build and complete private release: PASS;
- fresh final-D6 package, runtime doctor, real CoreML job, qualified child PATH
  and post-run immutability: PASS;
- dedicated service-account creation, protected config/credential installation,
  restrictive ownership/modes, system LaunchDaemon install/doctor/restart and
  a real CoreML job under `_musicmute` against a loopback acceptance fixture:
  PASS;
- final stable `0.1.0` package build, install, Doctor and activation: PASS,
  33,831 immutable entries and active `current -> releases/0.1.0`;
- stable-release service-context output: PASS, 97,845-byte 4.0-second stereo
  44.1 kHz MP3 with SHA-256
  `fe7a34782b01d2ca19ae28d0a227a767b7206aa41f96cb56f03d0e8ccde6f717`;
- rebuilt `0.1.1` installer qualification: PASS, 33,843 immutable entries,
  all four recipes under `_musicmute` through CoreML, strict protected-report
  validation, normal LaunchDaemon restoration and active
  `current -> releases/0.1.1`;
- rebuilt `0.1.2` split-stage qualification: PASS, 33,852 immutable entries,
  all four recipes under `_musicmute` through CoreML, candidate left inactive,
  qualification evidence validated and accepted `0.1.1` service restored;
- logged-out operation, live backend/S3 transfer and reboot: NOT_RUN.

Normal administrator consent was used for the system-owned account,
`/Library` installation and LaunchDaemon registration. No administrator
password was collected or embedded, and no logout/reboot was attempted. D4
remains BLOCKED because the local loopback control plane is not live backend/S3
evidence and logged-out plus reboot recovery remain untested.

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
  artifact and keeps releases versioned. Candidate activation now snapshots the
  prior config, credential, wrapper and service definition; a failed update
  restores all four, restarts the prior version and verifies its runtime instead
  of combining an old service definition with candidate state. Incomplete
  existing installations fail before activation. Candidate and rollback starts
  now require a new durable `started` diagnostic after the start timestamp;
  WinSW wrapper status alone is not accepted as worker health. Uninstall
  preserves releases, credentials, models and job state.
- Generalized the private runtime doctor without weakening macOS checks. The
  Windows path accepts only Windows x86_64, Python 3.12,
  `onnxruntime-directml==1.24.4`, `audio-separator==0.47.0`,
  `DmlExecutionProvider`, the exact model and the offline FFmpeg capability set;
  conflicting ONNX Runtime distributions fail closed.

### D5 verification and current blocker

- Windows PE/manifest/builder/service-definition/PowerShell and qualification
  tests: PASS;
- full worker protocol drift, formatting, lint, typecheck and build: PASS;
- complete TypeScript worker suite: PASS, 31 files and 107 tests;
- complete Python engine suite, including accepted DirectML host selection:
  PASS, 32 tests;
- WinSW official asset/license download and pinned digest comparison: PASS;
- portable PowerShell 7.6.6 parsing, non-Windows fail-closed behavior and
  rollback-helper restore/remove execution: PASS on this macOS host;
- native Windows PowerShell, 31,331-entry private package, elevated
  install/doctor, restrictive SID ACL inspection and stable `0.1.0` activation:
  PASS on the accepted Z440 host;
- `LocalService` DirectML access, exact RX 580 adapter-0 selection, a real
  service-context Kim job, checked MP3 upload/complete flow against a loopback
  acceptance fixture, diagnostic-spool persistence and service restart: PASS;
- same-version repair preserving the credential, model, active marker and
  `LocalService` state: PASS;
- controlled invalid-credential repair: PASS for rejection and automatic
  restoration of config, credential, wrapper and XML; the restored service
  emitted a new durable `started` event and returned to `Running` on `0.1.0`;
- rebuilt `0.1.1` repair and installer qualification: PASS with 31,476
  immutable entries, all four recipes as `LocalService` through DirectML
  adapter 0, 896 accelerated model-node events, zero CPU model-node events,
  strict protected-report validation, normal WinSW XML restoration and the
  automatic service `Running` on `0.1.1`;
- rebuilt `0.1.3` split `Stage` transaction: PASS on the accepted Z440 with
  31,506 immutable entries and all four recipes under `LocalService`/DirectML.
  The first `0.1.2` attempt exposed that restoration incorrectly restarted a
  service which was stopped before staging. The transaction now records and
  restores the prior running/stopped state; native PowerShell parsing, local
  regression tests and the corrected native stage all pass. The candidate
  remained inactive, the `0.1.1` active marker/config/credential/wrapper/XML
  were preserved, and the service remained stopped as it was on entry;
- Windows one-command bootstrap orchestration and exclusive protected
  qualification export: PASS_LOCAL; native live-backend execution is NOT_RUN
  after the successful `0.1.3` stage. A later read-only SSH audit at
  `192.168.1.7` confirmed the automatic `MusicMuteWorker` service still uses
  `LocalService`, active release `0.1.1`, and preserved runtime config and
  credential; the service remains stopped exactly as it was before staging.
  The Mac-hosted backend was not reachable from Windows, so no live enrollment
  or S3 activation was claimed;
- logged-out operation, live backend/S3 transfer, interrupted-upgrade recovery
  acceptance and reboot: NOT_RUN.

D5 remains BLOCKED rather than complete. Native service, DirectML execution and
the rebuilt-candidate qualification gate are proven, but the fixture is not
live backend/S3 evidence and the logged-out, interrupted-upgrade recovery and
reboot gates remain open.

## D6 runtime safety and extension boundary

- Attempt workspaces are UUID-named children of one protected root. Input and
  output names come only from the fixed content-type map and fixed
  `vocals.mp3`; storage keys and user titles never become local filenames.
  Startup removes only stale UUID attempt directories, and every terminal path
  cleans only its validated attempt root.
- FFmpeg and ffprobe remain absolute regular executables invoked with argument
  arrays, `shell=False`, a `file`-only protocol and allowlisted MVP demuxers, no
  stdin, a 512 MiB individual FFmpeg allocation cap and hard timeouts. Input is
  capped at 1,000,000,000 bytes, decoded audio at 1,800 seconds/79,380,000
  stereo samples, intermediate files at their PCM bounds, tool output at 64 KiB
  and final MP3 at 30,000,000 bytes.
- Before processing, the supervisor requires 2 GiB available host memory and
  the declared input size plus a 2,300 MiB workspace reserve. Windows uses the
  native available-memory reading; macOS counts free, inactive and speculative
  `vm_stat` pages instead of treating reclaimable cache as exhaustion. Missing
  probes, low resources and spool exhaustion fail closed and disable new work
  for the affected runtime.
- Runtime events enter an ordered private JSONL spool with a stable stream ID,
  monotonically increasing sequence, 8 KiB record cap, 100-record pending cap
  and 8 MiB disk quota. Bearer/credential-like values, complete HTTP(S) URLs
  including signed S3 URLs and user-home path components are redacted before
  persistence. Exhaustion writes `spool-full.marker` and stops admission; no
  backend log delivery is claimed in this checkpoint.
- The Python provider boundary now has explicit
  `macos-arm64-coreml-v1` and `windows-x64-directml-v1` discovery/session
  adapters. Tests pin CoreML `CPUAndGPU` settings and DirectML sequential mode,
  disabled memory patterns and exact device selection. The TypeScript platform
  boundary maps those adapters to launchd/POSIX owner-only credentials and the
  Windows Service/LocalService NTFS ACL policy. Linux, CUDA, MIGraphX, Intel Mac
  and unqualified architectures fail closed.
- One child per unique GPU and one active process request per child remain hard
  invariants. A successive-job separator test proves the warm inference object
  resets per-file state, removes stale destination contents and keeps both job
  outputs in their own attempt directories.

### D6 verification

- complete backend verification after the final runtime-contract changes:
  PASS, 108 Vitest files/731 tests, 22 E2E files/135 tests and production build;
- full protocol drift, formatting, lint, typecheck and production build: PASS;
- complete TypeScript worker suite: PASS, 26 files and 73 tests;
- complete Python engine suite: PASS, 32 tests;
- runtime-derived enrollment qualification gate: PASS in focused tests for
  verified release/doctor/hardware composition, all-recipe evidence, service
  identity and rejection of CPU provider fallback;
- real-FFmpeg four-recipe pipeline and reference trimmer parity: PASS;
- real M4/CoreML packaged job: inherited PASS from D4 evidence;
- real Mac LaunchDaemon/CoreML and Windows Service/DirectML loopback acceptance:
  PASS as recorded in D4/D5, but the new final qualification command, real
  enrollment, live backend/S3, logged-out and reboot acceptance are NOT_RUN.

## Limits

This is local protocol/pipeline/runtime evidence. It does not prove live S3 or
deployed-backend integration, WebSocket hints, the new qualification command
through either installed native service, logged-out behavior, reboot survival,
denoise listening quality or release readiness. D4 and D5 prove native service
execution only against bounded loopback acceptance fixtures. D6 proves local
safety and extension boundaries; it does not promote those platform results to
live fleet enrollment evidence.
