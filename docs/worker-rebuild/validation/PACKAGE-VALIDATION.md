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

- The final local pre-publication gate on September 21, 2026 passed worker
  protocol sync, formatting, zero-warning lint, typecheck, **48 TypeScript test
  files / 200 tests**, **32 Python engine tests**, and the production build (the
  two opt-in LaunchAgent tests are excluded from the default gate). Both opt-in
  tests were then run separately against the real current-user `launchctl` GUI
  domain: the one-shot qualification agent passed, and a persistent test-owned
  agent restarted with a new PID after its recorded PID was killed. The test
  refuses to boot out or replace a pre-existing MusicMute service. Backend
  formatting, zero-warning lint, typecheck, tracked-secret scan, **114 unit
  files / 809 tests**, **23 E2E files / 140 tests**, and the production build
  also passed. A fresh unpublished npm tarball contained 178 entries, installed
  into an isolated user prefix, ran `--help` and a clean uninstalled
  `status --json`, returned stable exit `2` for non-TTY install, unknown usage,
  and non-root legacy cleanup, and contained none of the forbidden model,
  credential, environment, virtualenv, dependency-tree, or private-key paths.
  After the real-macOS path and terminal-output fixes, the rebuilt unpublished
  tarball was installed globally from disk without contacting or publishing to
  npm. Its 178 entries include the Apache-2.0 license and only Python source
  files from the engine; bytecode caches and all other forbidden paths are
  absent. Its local SHA-256 is
  `e037e3c0bb51096db6dcc343b03ee47add480aa76665e59c13605cce899bad1e`.
- The globally installed CLI was exercised against the real current-user
  LaunchAgent after the terminal-output change. `doctor`, `status`, and `logs`
  rendered readable non-JSON views by default, while each `--json` form parsed
  with its stable fields. A real `restart` completed successfully, changed the
  service PID, and returned to healthy/connected/idle state. Real `pause`,
  `drain`, and `resume` transitions also returned readable summaries; the
  JSON-opt-in resume parsed correctly, and the final worker state was active,
  running, healthy, and accepting claims.
- The exact production `musicmute-worker update --check` command passed on the
  existing installation with no local `config/update-trust.json`. It verified
  signed catalog sequence `1` through the built-in reviewed Ed25519 public key,
  reported `0.1.0-mvp.2` as current with no update available, and returned
  readable output. Its `--json` form also parsed successfully. The trust file
  remained absent before and after both checks, proving the operation stayed
  read-only; the worker remained active, healthy, running, and accepting jobs.

- A regression test now terminates a child with a pending request and restarts
  it immediately. The supervisor replaces the lifecycle wrapper instead of
  reusing state whose exit event may still be pending. The complete worker
  verification passed with **48 TypeScript test files / 200 tests**, **32
  Python engine tests**, protocol drift, formatting, zero-warning lint,
  typecheck, and production build.
- Immutable local release `0.1.0-mvp.3` was built from that verified tree with
  the existing private Node 24, Python, FFmpeg/FFprobe, and license payloads.
  Its 12,697-entry release manifest verified before staging. The packaged
  Kim Vocal 2/CoreML qualification completed all four recipe variants in
  97.6 seconds, the current-user LaunchAgent started from the new release, and
  the local runtime doctor passed all 13 checks.
- Production then assigned retry attempt `dde570fb-a855-4ca1-8cb8-ea4a603d0bc9`
  for the earlier failed job. Further owner retries
  (`77c6ef49-cf42-4fb5-8f2f-9254feae2413`,
  `955d0307-b86b-4bef-b443-0d3dfee6795e`, and
  `339dc7b8-a58d-4da8-8b16-c7f3aea37197`) reproduced termination at the
  job's frozen 60-second deadline even though the live fleet policy displays
  the intended 7,200 seconds. The diagnostic recorded
  `child-process-failed` with the safe detail `Worker child process timed out`;
  most importantly, the supervisor automatically started a replacement Python
  child and remained connected and claimable. This proves recovery and
  diagnostic behavior, not a completed output upload. The owner must submit a
  completely new job from the mobile client to prove the final production
  download/process/upload/completion path; retrying the old job cannot adopt a
  newer policy revision.

- A newly submitted audio-file job `6ab1431b0288918db41d6982` was claimed as
  attempt `20682fa5-c7ae-4c4f-aed1-f6edf8d39deb`. Kim Vocal 2 produced a
  measured 2m39s output from the declared 2m42s input. The attempt completed
  separation within its initial lease window, so it did not prove processing
  beyond 60 seconds. Publication then failed with `OUTPUT_UPLOAD_FAILED`;
  direct AWS console inspection with versions visible found zero objects under
  that attempt's exact S3 prefix. This narrows that attempt's publication
  failure to output-grant/PUT acceptance before object creation.
- Transfer diagnostics now expose only a bounded stage or HTTP status in the
  private worker stream. Focused formatting and lint pass; transfer/runtime
  tests pass **16/16**. Full-tree formatting and typecheck are currently blocked
  by unrelated in-progress edits in `diagnostic-bundle.ts`,
  `operational-logs.ts`, and `local-runtime-status.ts`, which were preserved.
- Diagnostic release `0.1.0-mvp.5` verified **12,697** manifest entries plus
  its `WorkerRuntime` and `TransferError` ESM exports before activation. The
  earlier `0.1.0-mvp.4` overlay failed its ESM import, was immediately rolled
  back before claiming work, and is not active. Owner retry evidence is still
  required to identify and correct the exact output-upload rejection.
- Live filtered event following then captured fresh job
  `6ab150230288918db41d6986`. Attempts
  `5fb1155c-839d-45a3-9819-6cf75193fbf3`,
  `818d5ecf-81b5-4f0b-9542-4459b8783626`, and
  `6b7434c9-96fe-45dc-a4f4-03825732cfbd` each started normally and were killed
  after about 54 seconds with `Worker child process timed out`, followed by
  public `SEPARATOR_FAILED`. Source inspection showed that the child request
  timer used `LeaseAuthority.remainingMs()`, which is the minimum of the
  renewable lease and fixed deadline. Renewing the lease updated authority but
  could not update the existing child timer.
- The runtime now uses `deadlineRemainingMs()` for the bounded child request;
  lease renewal and the independent authority watchdog continue to fail closed.
  Focused Prettier, zero-warning Oxlint, TypeScript typecheck, production build,
  and **13/13** lease/runtime tests pass. Local release `0.1.0-mvp.8` differs
  from `0.1.0-mvp.7` only in the compiled worker-runtime and lease-authority
  artifacts plus its regenerated manifest. All **12,706** manifest entries
  verify, the exported deadline method loads as ESM, and the current-user
  LaunchAgent restarted healthy on a new PID with all 13 Doctor checks passing.
  A new production job has not yet arrived, so end-to-end processing and S3
  publication on `mvp.8` remain unproven.
- Live `logs --errors --since 1h` and `logs --errors --attempt-id` validation
  exposed that structured filters were followed by the complete historical
  stderr tail. This made unrelated `mvp.4` module-format and `mvp.5` EPIPE
  failures appear under a selected attempt. Filtered views now omit raw stderr;
  the unfiltered `logs --errors` behavior is preserved. The exact production
  attempt filter now returns only the two matching records for
  `6b7434c9-96fe-45dc-a4f4-03825732cfbd`.
- The historical EPIPE also identified a real process-safety gap. The child
  stdin stream now has an error listener that routes failure through the
  supervisor. A fixture closes descriptor 0 after the ready frame and proves
  the parent rejects safely without an uncaught event. Focused CLI and child
  lifecycle tests pass **25/25**, with formatting, zero-warning Oxlint,
  typecheck, and production build passing.
- Immutable local release `0.1.0-mvp.9` differs from `mvp.8` only in the
  compiled child-process and macOS user-CLI artifacts, their source maps, and
  regenerated manifest. All **12,706** entries verify. After activation the
  LaunchAgent restarted on PID 44226, all 13 Doctor checks passed, and status
  reported healthy, connected, idle, and accepting jobs. A sanitized six-file
  diagnostic bundle was generated at
  `~/Downloads/musicmute-worker-diagnostics-2026-09-21T16-04-14.796Z.zip`.
  The rebuilt unpublished npm tarball was installed locally so the public CLI
  matches the service release; no npm publication occurred.
- Three post-`mvp.9` production retries reached output publication but emitted
  `OUTPUT_UPLOAD_FAILED` with no S3 object. Comparing the exact production
  grant builder with worker validation proved the cause: the backend signs
  `x-amz-storage-class: INTELLIGENT_TIERING`, while the worker rejected any
  fourth header before issuing its PUT. This reconciles the empty S3 prefix
  with the generic pre-transfer diagnostic.
- The transfer client now permits only that exact optional storage-class value
  in addition to `Content-Type`, checksum, and `If-None-Match`. A valid
  production-shaped grant reaches PUT; an alternate storage class fails before
  fetch with `upload-header-mismatch`. Focused transfer/runtime tests pass
  **17/17**, with formatting, zero-warning Oxlint, typecheck, and build passing.
- Accepted release `0.1.0-mvp.10` was preserved. Immutable `0.1.0-mvp.11`
  differs only in compiled transfer code, its source map, and regenerated
  manifest; all **12,706** entries verify. It is active on PID 65277 with 13/13
  Doctor checks, connected, idle, accepting claims, and no post-activation
  errors. A fresh Android job is required for final S3 acceptance evidence.

- The macOS user CLI dependency preflight was exercised on the local Apple
  Silicon development host. It selected the trusted Node `24.18.0` for reuse
  and rejected the trusted but older FFmpeg/FFprobe `8.0.1` pair in favor of
  the pinned private `8.0.3` runtime. Focused tests also cover missing,
  untrusted, malformed, newer-major, and below-minimum components. The CLI
  does not mutate Homebrew or another global installation.
- A final read-only host check ran on macOS `26.6.2` and reconfirmed those exact
  Node/FFmpeg versions. TLS and DNS for `https://api.music-mute.com` were
  reachable; unauthenticated probes of `/`, `/api/v1`, `/api/v1/health`, and
  `/health` all returned `404`, so this proves only the configured production
  hostname is reachable, not worker enrollment or API readiness. The npm
  manifest still has `"private": true`; no publish was attempted.
- Focused installation tests prove a byte-and-SHA-matching model already in the
  MusicMute cache is copied locally into the protected transaction and causes no
  owner-host network request. Runtime matrix tests also prove a genuinely
  missing executable is reported as missing and an incomplete or mismatched
  FFmpeg/FFprobe pair is upgraded together rather than partially reused.
- Interrupted installation now reuses its private retained one-use credential
  without prompting for a second code. Conservative uninstall recovery
  verifies and reactivates the preserved release without enrollment, while a
  failed runtime doctor rolls activation back. Direct secret-prompt tests cover
  non-interactive refusal, cancellation, control characters, length bounds,
  and terminal-echo restoration. Purge authorization now requires an atomic
  owner-only backend-confirmed unpair receipt; manually deleting the credential
  does not authorize deletion, and interrupted post-confirmation cleanup is
  replay-safe. The backend now admits an already-revoked credential only on the
  unpair endpoint, where it returns the existing confirmation after a lost
  response; all other worker routes continue to reject that credential.
- The owner-only CLI command lock race test passed 20 consecutive focused runs
  after its acquisition proof was made deterministic.
- The owner-authorized Kim Vocal 2 URL was downloaded through the CLI's strict
  downloader with the approved redirect hosts and matched both `66,759,214`
  bytes and SHA-256
  `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
  A fresh native ARM64 Python 3.13.7 environment then ran the real graph twice
  against the deterministic eight-second fixture. Both stereo WAV outputs
  were valid; ONNX Runtime recorded six CoreML provider node events and zero
  CPU-provider model events, so provider dispatch was proven. This is local
  hardware/runtime evidence, not live backend/S3 or production enrollment.
- The explicit updater now requires both LaunchAgent startup and a passing
  packaged runtime doctor before recording a candidate healthy. A focused
  failure test proves doctor failure restores the previous release, preserves
  installation state, and quarantines the candidate. Owner-only CLI locking
  also rejects concurrent mutations and safely recovers a dead-process lock.
- The administrator-only legacy migration helper is implemented and tested for
  exact service targeting, backup-first moves, non-root refusal, and unsafe
  marker refusal. It exposes no caller-controlled service label or filesystem
  root and never deletes the timestamped backup.
- The local `status` command now uses a strict read-only machine status route
  and reports effective claim permission from both local intent and dashboard
  authority. Client/backend tests cover paused remote authority, active-attempt
  counts, response validation, and a backend-unavailable state that fails
  closed. Displayed logs are sanitized again at read time; focused tests prove
  credentials, signed URLs, and user paths are redacted.

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

No live S3 integration, production WebSocket deployment, listening-quality review,
npm publication, signing with production keys or deployment has occurred. The
The raw WebSocket ticket, one-use rejection, hint delivery and worker wake-up
paths have local automated coverage only. C1-C6 backend, D1-D3 runtime and
E1-E5 dashboard work are locally verified only. D4 and D5 now
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
