# Package validation record

## Executed during preparation

The following historical checks were completed while preparing the original
documentation package:

- All seven branch task files exist and their ordered checkpoint headings match the manifest and roadmap: **36 unique checkpoints**.
- JSON documents parse; local Markdown links resolve; fenced code blocks are balanced.
- The archived `reference/separate.py` matches the supplied upload byte-for-byte and its documented function line ranges match Python AST locations.
- The original trimmer passed **eight synthetic sample-count cases**. This is not a GPU or refactored-runtime test. See [results](trimmer-reference-tests.json).
- A temporary synthetic Git repository executed all **seven sequential branch/regular-merge/fast-forward milestones**, preserving main and clean-slate. The ignore-pattern regression was also checked. See [Git results](git-workflow-test.json).
- The package directory was checked for expected members, unsafe links, JSON validity, local Markdown links, and content hashes. SHA256SUMS covers all package files except itself.

The package build contains no environment files, credentials, models, audio fixtures, installed dependencies or service binaries. The only Python file is the unchanged user-provided archival reference. Obvious placeholders and synthetic identifiers are intentional documentation, not deployment settings.

## Executed after preparation

- The architecture contracts were reconciled to the clean-slate source, validated,
  reviewed and merged through PR #6.
- The B1 isolated probe and its five focused unit tests pass on native ARM64
  Python 3.13.7.
- The real `Kim_Vocal_2.onnx` graph produced valid output on the M4 Pro, with
  ONNX Runtime profiling assigning six model node events to CoreML and none to
  the CPU provider. See [B evidence](../evidence/B-gpu-feasibility.md).
- The same model and deterministic fixture produced two valid outputs on the
  real Z440/RX 580. The ONNX Runtime profile assigned 672 model node events to
  DirectML and none to the CPU provider; the isolated environment passed
  `pip check` and its full lock was captured.
- The package manifest was refreshed after adding the B evidence; SHA256SUMS
  again covers every package file except itself.
- C1-C6 backend implementation passed formatting, lint, typecheck, tracked
  secret scanning, 107 unit-test files with 727 tests, 22 E2E files with 135
  tests, 12 processing integration tests against isolated local services, and
  a production NestJS build. See [C evidence](../evidence/C-control-plane.md).
- D1 added the standalone worker package and passed protocol drift, formatting,
  lint, typecheck, 10 TypeScript tests, 4 Python IPC tests, production build and
  built-CLI/Python-child handshake checks. See [D evidence](../evidence/D-runtime.md).
- D2 added the four immutable recipe snapshots and safe ordered pipeline. It
  passed 13 Python engine tests, 10 TypeScript tests, 42 focused backend tests,
  the full 729 backend unit and 135 E2E tests under the env-isolated procedure
  recorded in the evidence, reference PCM parity and a real framed M4/CoreML
  Kim-to-MP3 child run. See [D evidence](../evidence/D-runtime.md).
- D3 added authoritative HTTPS reconciliation, ownership safety, exact transfer
  execution and lost-response recovery. It passed 25 TypeScript worker tests,
  13 Python engine tests, a local real-HTTP full runtime sequence, 13 focused
  backend tests, the complete 732 backend unit/package tests and 135 backend
  E2E tests under the recorded env-isolated procedure. See
  [D evidence](../evidence/D-runtime.md).
- The service-context enrollment gate is now part of both native installer
  transactions: a one-shot `_musicmute`/CoreML LaunchDaemon on macOS and a
  one-shot `LocalService`/DirectML WinSW service on Windows. Strict evidence
  parsing, atomic report publication, active-service restoration and rollback
  paths pass the full worker verification (31 TypeScript files/111 tests and 32
  Python tests). The candidate script also passes native Windows PowerShell
  parsing on the authorized Z440 host, and rebuilt `0.1.1` candidate
  installation/qualification passes on both MVP hosts.
- The local installation transport now includes a strict backend catalog and
  installation-authenticated download grants for the platform release, model
  and fixture; a resumable `prepare-installation` CLI downloads and verifies
  the set without persisting signed URLs. Preparation also rejects unsafe
  archive paths, extracts through a protected temporary root, verifies the
  immutable platform manifest/catalog version and atomically publishes the
  versioned release directory. Platform package commands emit the matching
  exclusive archive and report its exact catalog metadata. Qualification now
  selects one exact
  service-context output for an immutable S3 PUT, confirms its version and
  blocks activation until confirmation. Changed local bytes, reservations,
  versions and response metadata fail closed. This passes the complete worker
  verification (31 TypeScript files/111 tests, 32 Python tests and build) and
  complete backend verification (110 unit files/749 tests, 22 E2E files/135
  tests and build). The backend E2E suite also passed five consecutive runs
  after the shared harness switched to an explicit loopback listener.
- D4 implementation now covers deterministic native ARM64 release manifests,
  private dependency auditing, dedicated-account LaunchDaemon files, secure
  state/model provisioning, repair/rollback and safe uninstall boundaries. Its
  reproducible network-disabled FFmpeg 8.0.3/LAME 3.100 build, complete private
  package, local tests, packaged runtime doctor, post-run immutability check and
  real CoreML pipeline pass. A fresh package from the final D6 runtime also
  proved the qualified child `PATH` fix, runtime doctor, real CoreML job and all
  33,828 immutable entries. The system LaunchDaemon was then installed with an
  automatically provisioned hidden `_musicmute` account, passed doctor,
  restrictive ownership/mode checks, restart and a real service-context CoreML
  job against the loopback acceptance fixture. The final stable `0.1.0`
  package with 33,831 entries was installed and activated, then completed a
  checked 97,845-byte service-context output. Logged-out, live backend/S3 and
  reboot gates keep the checkpoint BLOCKED. See
  [D evidence](../evidence/D-runtime.md).
- The split macOS stage/activate transaction was then exercised with a fresh
  33,852-entry `0.1.2` candidate. The stage used no placeholder machine
  identity, ran all four recipes as `_musicmute` through CoreML, left the
  candidate inactive and restored the accepted `0.1.1` service. Runtime
  enrollment now writes the final service config only after backend activation.
- D5 implementation now covers x86_64 PE and immutable release validation,
  pinned WinSW acquisition, password-free LocalService configuration,
  SID-scoped ACL/install/repair/rollback/uninstall tooling and an exact
  DirectML runtime doctor. Rollback now restores candidate-overwritten config,
  credential, wrapper and XML state before restarting and verifying the prior
  release. Five focused TypeScript files with ten tests, portable PowerShell
  7.6.6 parsing and rollback-helper execution, the complete 49-test worker
  suite and the 21-test engine suite pass locally. On the accepted Z440, the
  31,331-entry package, native elevated installer, `LocalService`, restrictive
  ACLs, DirectML adapter 0, runtime doctor, service restart and a real
  service-context Kim job all passed. The stable `0.1.0` release is active.
  Same-version repair and a controlled invalid-credential rollback also passed,
  including restored credential/service files and a new durable `started`
  event. The active immutable package predates that readiness fix, so a new
  package version plus logged-out, live backend/S3, interrupted-upgrade and
  reboot gates remain open. See [D evidence](../evidence/D-runtime.md).
- D6 locally verifies attempt isolation, trusted filenames, bounded
  media/subprocess/resource behavior, signed-URL and secret redaction, an
  admission-blocking 8 MiB diagnostic spool, one-job capacity, warm-model
  cross-job cleanup, explicit CoreML/DirectML session adapters and explicit
  macOS/Windows service/credential policies. Runtime-derived enrollment now
  verifies the immutable release and runtime doctor, collects only accepted
  host/GPU fields, and requires four-recipe service-identity qualification
  evidence with accelerated ONNX node dispatch and zero CPU model-node
  fallback. The current complete worker suite passes 31 TypeScript files/111
  tests and 32 Python engine tests, including bounded enrollment exchange/
  report/activation, replay recovery, protected credential files, secret-free
  CLI output and fail-closed qualification parsing. Native installer
  qualification also passed on rebuilt `0.1.1` releases: all four recipes as
  `_musicmute` through CoreML on the Mac M4, and as `LocalService` through
  DirectML adapter 0 on the Z440/RX 580 with 896 accelerated model-node events
  and zero CPU model-node events. Both native installers restored the normal
  active service definition after the one-shot gate. The backend also passes
  its full verification after the final runtime-contract changes: 110 Vitest
  files/749 tests, 22 E2E files/135 tests and production build. See
  [D evidence](../evidence/D-runtime.md).
- E1-E5 add the protected worker administration surface and its bounded backend
  projections. Complete backend verification passes formatting, lint,
  typecheck, tracked-secret checks, 110 unit files/753 tests, 22 E2E files/135
  tests and build. Complete dashboard verification passes formatting, lint,
  typecheck, 18 unit files/56 tests, production build and 32 Chrome browser
  tests covering permissions, compiled contracts, adverse states, responsive
  widths and accessibility. See [E evidence](../evidence/E-dashboard.md).

## Not executed or claimed

No live S3 integration, WebSocket hint transport, listening-quality review,
npm publication, signing with production keys or deployment has occurred. The
C1-C6 backend, D1-D3 runtime and E1-E5 dashboard work are locally verified
only. D4 and D5 now
have native package, installed-service, accelerated processing and final
four-recipe qualification evidence on the two MVP hosts, but neither checkpoint
is complete. D6 has local automated evidence. Android and iOS were not changed.
The dashboard has isolated-browser acceptance but no production deployment or
live fleet acceptance. Real fleet enrollment, live backend/S3, logged-out and
reboot acceptance remain unverified. The upload-candidate report and artifact
preparation contracts have now passed rebuilt native macOS and Windows stages,
but not a live backend/S3 enrollment. Windows
interrupted-upgrade recovery and all Linux/NVIDIA or other hardware also remain
unverified.

## Source/consistency caveats

Repository inspection was targeted and pinned to the recorded clean-slate/rebuild commit, not a whole-codebase audit. Paths discovered through imports are marked separately in the study map. Credentials, production domains and performance claims beyond the two recorded hosts are not fabricated. The chosen optional denoise preset is a documented MVP design decision, not a proven universal quality optimum.
