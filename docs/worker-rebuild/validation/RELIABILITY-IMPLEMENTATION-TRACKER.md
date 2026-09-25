# Approved reliability implementation

User approved all eight recommendations, implementation, tests, benchmark and
controlled one-worker canary. Branch: `hatem/worker-production-reliability`.
No commit, push or public publication is implied. Preserve existing local fixes.

| Task | Completion evidence required | Status |
| --- | --- | --- |
| 1. Process ownership | Isolated supervisor SIGKILL during work removes child/decoder descendants; later attempt succeeds; Windows ownership implemented and native proof distinguished | macOS source and packaged parent-death fixtures pass; Windows ownership implemented, native Windows acceptance pending |
| 2. Interrupted lifecycle/update | Safe stale-lock handling; durable transaction recovery; interruption tests at service and activation boundaries; original intent preserved | macOS journal recovery, startup reconciliation, install finalization and kernel locks implemented/tested; actual install/update termination boundaries and native rollback health pending; Windows crash recovery remains open |
| 3. Persistent restart budget | Cross-launch crash budget, transient backoff, actionable exhaustion, recovery tests | Persistent budget/idle recovery tests and native packaged macOS crash-budget/quiescence/reset proof pass; Windows reset source contracts pass, native Windows service/ACL acceptance pending |
| 4. Capacity receipts | Failed run invalidates evidence; installed identity binding; representative repeated benchmark and resource/output evidence; no automatic two-slot activation | Receipt invalidation and identity checks pass; real source and packaged one-slot MPS benchmarks complete; sustained representative two-slot, peak resource and listening acceptance pending |
| 5. Installer transfers | Shared deadline across redirects, inactivity, cancellation, partial writes, cache preservation, fault tests | Shared deadline, inactivity, cancellation and partial-write fault tests pass; packaged loopback transfers pass; final packaged real-storage fault acceptance pending |
| 6. Filesystem failure | Fault-injected stalls/errors; isolation/ownership prevents unsafe cleanup and false recovery; documented host-failure boundary | Job transfers isolated with owner-aware cleanup and fault tests; supervisor/installer/diagnostic filesystem waits remain a host-failure boundary |
| 7. Remote observability | Durable acknowledged diagnostic forwarding, bounded reporting; synthetic Sentry event visibly received and correlated | Durable forwarding and replay tests pass; synthetic Sentry HTTP 200 received; visible event/alert, live backend delivery and S3 archival remain open; reinstall cursor reconciliation implemented with isolated API proof |
| 8. Packaged canary | Complete candidate integrity, benchmark, controlled end-to-end S3/cancellation/lease-loss/acknowledgement tests, rollback proof | Private candidate integrity, compiled fixtures and real MPS benchmark pass for recorded snapshots; final rebuild and live backend/S3 canary with cancellation, lease loss, acknowledgement loss and rollback pending |

Execution order: isolate/fix faults, run focused tests, validate complete candidate,
inspect and drain live service, benchmark with no competing production workload,
then controlled activation and acceptance. Restore prior lifecycle intent and
retain known-good rollback assets. Do not claim completion from fixture tests
where native or live evidence is required. Do not run destructive experiments
against production jobs, host storage or unrelated user data.

## 2026-09-25 implementation evidence

- POSIX guardian/child/supervisor focused suites: 12 tests passed. The isolated
  parent-death fixture simulates busy inference and verifies guardian, engine and
  decoder descendant exit. Windows ownership and native packaged proof remain open.
- Artifact downloads now share one overall deadline through redirects, use a
  30-second default inactivity budget, accept cancellation, cancel rejected bodies,
  and complete partial writes before integrity activation. Qualification PUTs use
  the same budget and reset inactivity on body consumption, including a bounded
  wait for response headers. Fetch body consumption is not remote byte acknowledgement.
- Fault tests prove short-write completion, zero-write rejection, a real HTTP body
  stall, a shared deadline across redirects, response cancellation, immutable cache
  reuse, and no qualification confirmation after a stalled PUT.
- Full TypeScript suite after guardian/transfer changes: 307 passed, 2 skipped
  (58 test files passed, 1 skipped). Subsequent atomic lifecycle initialization
  change: 4 lifecycle tests passed, including simultaneous initialization and
  preservation of existing paused intent. Lifecycle and qualification suites also
  passed together (8 tests before the new concurrency test).
- Lifecycle initialization now publishes a complete synced file through exclusive
  hard linking; updates retain atomic rename. POSIX parent-directory sync follows
  publication. No empty authoritative lifecycle placeholder is created.
- These changes are local. No installed runtime, service, production job, GPU slot,
  or cloud resource was modified by this implementation batch. No benchmark or
  canary claim follows from these fixture tests.

## Interrupted-update recovery evidence

- The updater persists previous release, lifecycle intent, and service loaded state
  before draining or stopping. Journal publication syncs file and parent directory.
- Rollback verifies the previous immutable bundle, rejects an unrelated active
  pointer, drains a running candidate, restores the pointer/installation version,
  restores lifecycle intent and prior service state, and only then closes the journal.
  Failed restoration retains the pending journal for a later retry.
- `start`, `restart`, and `resume` reconcile pending update journals under the existing
  CLI command lock after argument validation. A subsequent update also reconciles
  first. Legacy incomplete journals fail closed with an operator-recovery message.
- Updating a deliberately stopped worker no longer starts it. Paused intent is
  preserved. Tests cover staged and activating snapshots, failure after stopping
  before qualification, repeat recovery, and failed bootstrap followed by retry.
- Full TypeScript suite: 313 passed, 2 skipped. Typecheck, lint, build and diff check
  passed. After the final guard and CLI ordering changes, the updater/CLI
  focused rerun passed 54 tests; the subsequent updater suite passed all 20 tests
  including explicit rejection of an unrelated active release.
- Still required for task 2: actual process interruption boundary tests, safe stale
  lifecycle lock recovery, unattended startup reconciliation, and installation
  transaction recovery. Snapshot tests alone do not close those requirements.

## Capacity admission evidence

- A two-worker benchmark invalidates the previous PASS durably before qualification;
  the lower-level capacity runner also invalidates before parsing its baseline.
  PASS publication uses a synced temporary file, atomic rename and directory sync.
- Concurrent capacity runs are both awaited before workspace cleanup, including
  when one fails. This avoids the previous Promise.all early-rejection cleanup race.
- Version 2 receipts bind recipe IDs, verified installed release inventory, model
  and fixture bytes, configured Python/FFmpeg/FFprobe paths, and an Apple Silicon
  SoC/memory/OS signature. Version 1 receipts cannot authorize two slots anymore.
  Windows two-slot qualification remains unsupported by this macOS evidence path.
- Offline benchmark identity reading returns only machine ID and does not expose
  an unchecked runtime config; a failed/expired receipt cannot prevent a rerun.
- Tests verify failed-rerun invalidation, legacy rejection, current receipt admission,
  changed-host rejection, changed model/fixture/engine detection, and executable
  path mismatch. Installed artifact checks use synthetic local files, not live models.
- Full worker suite: 316 passed, 2 skipped. Typecheck and lint pass. No real GPU
  benchmark was run and no production capacity changed. Repeated warm/cold runs,
  sustained resources/output quality, and native canary evidence remain required.

## Restart policy evidence

- Service startup admission is persisted before config/model initialization. Five
  consecutive starts without successful work exhaust the budget; abrupt termination
  consumes an admission even when no failure callback executes. Backoff uses capped
  exponential delay with jitter and supports cancellation without another admission.
- Invalid configuration/protocol TypeErrors and nonretryable control-plane errors
  quarantine the service. Exhausted, corrupt, or unpersistable admission state leaves
  the service quiescent until stopped, rather than restarting the engine indefinitely.
- Successful authoritative job completion resets accumulated starts while retaining
  the current incarnation's reservation. Orderly shutdown clears it. Explicit macOS
  `restart` resets the persisted budget after stopping the service.
- Idle exited children are detected before claims and use bounded child recovery.
  Three idle exits without a successful job exhaust recovery even if each replacement
  initially starts. Existing resource/cleanup admission blockers remain independent.
- Full worker suite: 323 passed, 2 skipped. Focused budget/CLI tests passed (40), and
  budget/runtime/child tests passed (39 before the additional idle-crash-loop test).
  Native launchd/Windows service restart behavior, Windows operator reset workflow,
  and packaged fault acceptance are still required; in-process persistence tests
  are not those proofs.

## Diagnostic transport implementation

- Added the client for existing authenticated `POST worker/v1/logs`; requests obey
  the current session/incarnation contract and only exact end-sequence acknowledgements
  advance delivery. No backend routes or schemas changed.
- A separate private outbox pins the complete batch before sending, uses atomic
  synced publication, and retains the same remote sequence range and lines after a
  lost acknowledgement or process relaunch. Local source files are synced before
  extraction; retention/rotation cannot alter a pending batch already in the outbox.
- Large JSON records split into numbered text fragments (up to 20 bounded lines per
  batch) instead of truncation. Backend sanitization still applies. The outbox has
  a separate 128 KiB hard limit; local diagnostic retention remains unchanged.
- Forwarding begins after session establishment, runs outside reconciliation, uses
  a 10-second network budget and capped backoff, permits only one in-flight batch,
  and aborts transport on shutdown. Filesystem-stall isolation remains task 6.
- Tests cover lost acknowledgement/new-session replay, wrong acknowledgements,
  fragment reconstruction, bounded line sizes, cancellation without cursor advance,
  authenticated endpoint validation, and start-after-session integration.
- A changed diagnostic stream fails closed for delivery and requires reconciliation;
  native reinstall/clear interactions and remote archival visibility still require
  acceptance. Local tests do not prove that the live backend or Sentry received data.

- Diagnostic batch full-suite result: 329 passed, 2 skipped; build and diff check
  passed. Focused forwarding/runtime suites passed 34 tests; typecheck and lint
  passed before the final source-directory sync addition.

## Process ownership implementation and native boundary

- POSIX guardians now observe a separate parent IPC channel, independent of engine
  stdin backpressure. The busy-engine/decoder SIGKILL fixture passes with both empty
  and saturated input. The engine does not inherit guardian IPC environment markers.
- Windows production child startup is wired through a lightweight Python guardian.
  Before spawning it joins an unnamed, non-inheritable kill-on-close Job Object;
  descendants inherit job membership with no breakaway flags. A separate thread
  holds a SYNCHRONIZE-only supervisor handle so blocked pipe writes cannot hide death.
  Failure to establish ownership prevents engine startup.
- Windows ctypes contract tests verify flag/assignment ordering and fail-closed
  handle cleanup. Installed macOS Python ran 4 tests: 3 passed, 1 native Windows
  test skipped. The native test uses only sacrificial fixture processes and has a
  bounded readiness wait; it has not run on Windows yet.
- The previously saved Windows endpoint 192.168.1.7:22 was probed with noninteractive
  SSH and a 5-second connect timeout; connection timed out. No remote mutation was
  performed. Native Job Object/DirectML/service acceptance remains blocked on host
  availability, while other goal work can continue.
- Typecheck, lint, and build passed after Windows guardian wiring. The POSIX focused
  guardian/child suites passed 9 tests including the added backpressure case.

- Process-ownership batch full-suite result: 330 passed, 2 skipped. Subsequent
  guardian-only rerun after removing inherited IPC markers: 2 tests passed.

## Filesystem ownership fault evidence

- Job downloads recheck cancellation before/after filesystem operations. A delayed
  write cannot turn a cancelled transfer into success when it eventually settles.
- Failed file closure produces a nonretryable TransferOwnershipError. Download
  cleanup preserves its file; runtime cleanup preserves the whole workspace and
  blocks that slot with writer-not-closed evidence. Upload closure uses the same
  ownership classification. Installer partial files are also preserved on close
  failure rather than unlinked under an uncertain handle.
- Workspace cleanup no longer treats arbitrary lstat failures as an absent path.
- Fault tests delay a real file write, abort while it owns the handle, verify the
  path remains until settlement, and then verify cancellation/cleanup ordering.
  Separate tests inject EIO on closure and verify preservation and blocked claims.
- Full worker suite: 333 passed, 2 skipped. Focused transfers/runtime fault suites
  passed 40 tests. Lint passed after factoring handle-close classification into a
  helper; the initial inline throw in finally was rejected by the lint rule.
- An indefinitely unsettled filesystem operation still keeps its promise pending.
  These changes intentionally do not race a live writer with deletion. Process
  isolation, bounded termination, and safe recovery across launch remain open.

## Isolated job-transfer evidence

- Production job downloads/uploads now run in a one-operation child process. Signed
  grants travel over private IPC rather than argv/environment. Parent cancellation
  or total deadline kills the helper and waits for exit before returning ownership.
- The helper durably publishes a private ownership marker before transfer I/O.
  Workspace cleanup and startup reclamation reject live owners; a later transfer
  may reclaim a dead owner's marker. Unconfirmed termination preserves the workspace
  and uses the existing nonretryable ownership failure/admission block.
- New real-process/HTTP tests cover download then upload, timeout, cancellation,
  and simulated failed termination of a blocked helper. Both cleanup and startup
  reclamation preserve the live fixture owner. Test teardown kills that fixture
  before removing its files. The tests caught and fixed macOS /var versus
  /private/var canonical-path comparison.
- Full worker suite: 337 passed, 2 skipped. Typecheck, lint and build passed.
  Subsequent edits only narrowed the injectable fork type and removed an unused
  test import; no runtime behavior changed after this full-suite run.
- This does not close task 6: supervisor-side root canonicalization, workspace,
  diagnostic and installer filesystem operations remain outside this helper.
  Native packaged acceptance and host-level storage-failure limits remain open.

## Lifecycle lock publication

- Lifecycle writers now sync a private PID ownership record before exclusively
  linking it into the lock path. They no longer expose an empty lock between
  acquisition and owner-record writing. A losing writer removes only its own
  temporary record, preserving the existing lock and lifecycle state.
- New tests cover existing-live-lock preservation and eight concurrent transitions,
  requiring exact revision accounting and no remaining temporary files.
- Lifecycle/updater focused suites: 26 passed. Typecheck, lint, build, scoped
  formatting and diff check passed. No installed lifecycle file was changed.
- Safe stale-lock reclamation is still pending. PID metadata makes ownership
  diagnosable but does not itself solve simultaneous-reclaimer races or PID reuse;
  do not remove locks merely due to elapsed time or claim task 2 complete.

## Unattended update reconciliation

- Managed macOS `run` checks the update journal before creating engines or backend
  sessions. For an orphaned staged/activating transaction it verifies/restores the
  prior bundle, installation record and lifecycle intent under the command lock.
  The current process then exits before processing; launchd can relaunch the
  restored pointer. A previously stopped service requests a successful exit.
- Startup recovery does not bootout its own service or pretend to bootstrap it.
  It requires launchd's PID to match the current process. Only a confirmed live
  lock explicitly owned by an updating CLI permits candidate health startup;
  unknown lock records and other operations fail closed. CLI locks now record
  their operation purpose.
- Full suite before the final managed-PID guard: 342 passed, 2 skipped. Following
  the guard, updater focused suite: 23 passed; typecheck, lint and build passed.
  Native launchd SIGKILL/activation boundaries, stale-lock race-safe recovery and
  installation transaction recovery remain open. No live service was changed.

## Native macOS stale-lock recovery

- Added Darwin O_EXLOCK/O_NONBLOCK advisory locking on persistent private guard
  inodes for lifecycle and CLI mutations. Guard files are never unlinked during
  normal release; closing the descriptor or process death releases kernel ownership.
  Unsupported filesystems fail closed. Symlink/non-private/non-owned/non-regular
  guard files are rejected. This is macOS-specific, not Windows evidence.
- Recovery of a complete dead-PID lifecycle or command lock occurs only while
  holding that kernel lock, serializing simultaneous reclaimers. Live legacy
  owners and ambiguous empty/invalid legacy locks remain protected. PID reuse
  conservatively blocks recovery rather than assuming ownership has expired.
- CLI owner records now also publish atomically from a fully synced temporary
  file, avoiding new empty authoritative lock records after interruption.
- A native Node probe verified contention returns EAGAIN and close allows reuse.
  A sacrificial process then acquired the real helper lock; a lifecycle mutation
  was rejected while it lived, SIGKILL released kernel ownership, and eight
  competing lifecycle mutations recovered with exact revision accounting.
  Separate symlink tests verified no target mutation.
- Full worker suite: 344 passed, 2 skipped. Typecheck, lint, build, scoped format
  and diff check passed. No installed state, service or production job was changed.
- Darwin flag value was checked against the installed macOS SDK sys/fcntl.h;
  semantics: https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html
- Task 2 still needs actual update activation interruption and install recovery
  acceptance. Kernel-lock tests close the new macOS lock's abrupt-death/reclaimer
  gap, not those broader transaction boundaries or legacy ambiguous locks.

## Installation finalization recovery

- Installation now persists a private durable finalization journal after enrollment
  and credential installation, before writing runtime configuration. It records the
  stable installation timestamp, identity, expected release and runtime evidence;
  no credential value is copied into the journal.
- `install` checks this journal before the already-installed/configuration gate.
  Recovery verifies the current release pointer and bundle inventory, reuses the
  existing credential, completes config/lifecycle/status/plist/installation records,
  and loads the service if needed. Existing lifecycle intent and runtime status are
  preserved. Only successful service loading removes the journal and setup code.
- Private installation records now publish exclusively via hard link and sync their
  directory, rather than replacing a concurrently created destination by rename.
- The injected-bootstrap-failure test resumes through the real CLI `install` path,
  proves prepare/enroll were called only once, forbids another code prompt, preserves
  paused intent, and confirms the journal is consumed only after success.
- Full suite: 345 passed, 2 skipped. Build passed for the implementation. Actual
  process termination at each install/update boundary and real service health remain
  acceptance gates; this fault test is not native launchd or backend enrollment proof.

## First real MPS benchmark and restoration

- Ran the candidate engine on Apple M4 Pro using a project-owned 30-second fixture:
  one cold run, one warm-up, three measured runs. Median 2.044893s; range
  2.025224-2.053779s. MPS dispatch verified, fallback disabled; five valid outputs.
- Installed service was drained/stopped before GPU work and restored afterward.
  Independent status confirmed the original .43 release active, loaded/running,
  healthy, model/local ready and no blockers. No candidate activation or slot change.
- Detailed evidence and limits: RELIABILITY-MPS-BENCHMARK.md. This closes an initial
  real-GPU measurement gap, but not sustained representative two-worker capacity,
  listening quality, packaged benchmark or live S3 canary acceptance.

## Private packaged candidate and compiled helper verification

- Built a separate candidate at
  `/Users/hatemragap/.codex/tmp/musicmute-reliability-package-sm0s7fvm/candidate-v2`,
  version `0.1.0-mvp.44-reliability.local.20260925.2`, 20096 manifest entries.
  Reused verified installed Node/media inputs and a private copy of Python.
  The installed Python lacked sentry-sdk; installed the locked 2.70.0 SDK only
  into the private build input (existing certifi/urllib3 already satisfied imports).
  No source maps were uploaded and no candidate activation/publication occurred.
- Packaging exposed a real probe bug: Python `-I` ignores environment settings,
  so the SDK check wrote bytecode caches into its source runtime. Added explicit
  `-B`. Manifest diff proved only five new cache directories and no changed or
  removed pre-existing entries. Those exact new directories were moved to the task
  quarantine; installed release manifest verification then passed. They were not
  silently ignored by the manifest verifier or deleted broadly.
- Using the rebuilt bundle's own Node and compiled modules, real loopback
  download/upload preserved exact bytes and version acknowledgement. Busy engine
  and decoder descendants exited after sacrificial parent SIGKILL with both empty
  and saturated input. The Python SDK probe then ran against the bundle itself.
- Candidate and original installed manifests verified afterward. Evidence is in
  `smoke-evidence.json` beside the candidate; service health snapshot is
  `installed-health-after.json`. Source typecheck, lint and build passed; seven
  focused release-builder/package tests passed. Diff check passed.
- This is packaged fixture acceptance, not real packaged GPU/S3 canary, native
  Windows, live telemetry delivery or rollback acceptance. Those gates remain open.

## Packaged three-minute MPS benchmark

- The separate candidate bundle ran one cold, one warm-up and three measured
  passes over a project-generated 180-second fixture using its packaged runtime.
  Median 9.184825s, range 9.128351-9.775841s; MPS dispatch proven, fallback disabled.
  All five outputs retained 180 seconds. Boundary driver/tensor allocations were
  stable (300.70/64.59 MiB); these are not peak measurements.
- The bundle manifest verified after execution. Before GPU work, the installed
  worker was drained/stopped without force. Finally it was restored; the runner
  and independent status read confirmed the original .43 release active, running,
  healthy and ready. No candidate activation, capacity change or S3 job occurred.
- Details and artifacts are in RELIABILITY-MPS-BENCHMARK.md. Packaged local engine
  execution is now proven, while representative listening quality, sustained
  two-worker capacity, native Windows and real canary failure scenarios remain open.

## Live Sentry submission and diagnostic clear/replay evidence

- Packaged Node reporter sent one synthetic attempt-failed event to its configured
  Sentry destination in environment `reliability-canary`, using generated IDs and
  no real job data. SDK afterSendEvent reported HTTP 200 and flush completed.
  Event ID: `5b22f5842d53498ea4e6a427b2aeccce`.
  Local evidence: `/Users/hatemragap/.codex/tmp/musicmute-reliability-package-sm0s7fvm/sentry-probe.json`.
- This proves transport acceptance, not visible Sentry issue/alert ingestion.
  Browser reached the organization's sign-in page; user sign-in was requested and
  the tab left available. No password was requested in chat or credential created.
- Source inspection confirms runtime log acknowledgements follow MongoDB diagnostic
  insertion and machine sequence update in a transaction. The inspected route does
  not write S3 archives. No live backend/S3 log delivery is claimed from this read.
- Added a real local spool regression: lose acknowledgement, clear local event
  history, record a new event, recreate the forwarder with a new session, replay
  the identical pending batch, then advance without remote sequence reuse.
  The acknowledged outbox is intentionally distinct from local history clearing.
- Six forwarding tests, typecheck, lint and diff check passed. Only a test changed;
  packaged runtime bytes remain as previously verified. Reinstall/stream-reset
  reconciliation and visible remote receipts remain open.

## Diagnostic lock ownership

- macOS diagnostic writers/clear operations now serialize through a persistent
  Darwin kernel advisory lock. Complete dead-owner records are reclaimed only
  inside that lock. New records publish from synced temporary files, eliminating
  the empty authoritative lock window for new writers.
- Removed age-based recovery of incomplete lock records on every platform. An
  unknown owner fails with an operator-recovery message; a slow writer is never
  declared dead solely because its metadata is old. Automatic dead-owner unlink
  remains disabled outside Darwin until native ownership serialization is available.
- Tests verify that an epoch-old empty lock is preserved and never enters the
  protected operation. Eight competing macOS recovery/writer calls preserve every
  read/modify/write mutation. Seventeen focused diagnostic tests passed, along
  with typecheck, lint, build, scoped formatting and diff check.
- This source change postdates candidate-v2; that earlier bundle's benchmark and
  Sentry evidence remain evidence for its recorded snapshot. Rebuild the candidate
  before final canary acceptance. No installed service/runtime was modified here.
- Full suite after diagnostic lock changes: 348 passed, 2 skipped (65 test files
  passed, 1 skipped).

## Windows reset workflow and refreshed private candidate

- Added `ResetRestartBudget` to the elevated Windows manager under its existing
  installer mutex. It requires the service to be stopped, rejects unsafe state
  directories/files, preserves the old budget by a unique rename, and leaves the
  service stopped. The next explicit start creates fresh state as LocalService.
  README documents repair/drain/stop/reset/start and custom installation roots.
- Updated the supported-action contract and added a source-only guard/order/
  preservation check. These are packaging contracts, not PowerShell execution or
  native Windows service/ACL proof. PowerShell is unavailable on this macOS host.
- Focused Windows tooling, release-builder and restart-budget suites: 10 passed.
  Full TypeScript suite: 349 passed, 2 skipped; 65 test files passed, 1 skipped.
  Typecheck, lint, build, scoped TypeScript formatting and diff check passed.
- Rebuilt the separate private candidate from the current compiled source:
  `/Users/hatemragap/.codex/tmp/musicmute-reliability-package-sm0s7fvm/candidate-v3`,
  version `0.1.0-mvp.44-reliability.local.20260925.3`, 20096 manifest entries.
  Source-map upload credentials were excluded from the build environment.
- Candidate-owned Node and compiled modules passed real loopback download/upload,
  busy-parent SIGKILL descendant cleanup with empty and saturated input, and the
  Python SDK probe without bytecode mutation. Both candidate and original installed
  manifests verified afterward. Evidence: `smoke-evidence-v3.json` beside candidate.
- No service activation, live S3 job, new benchmark, commit or publication occurred.
  Earlier benchmark results remain bound to candidate-v2; v3 has only the package
  and compiled fixture acceptance recorded here. Native interruption/rollback,
  Windows acceptance, visible remote telemetry and live canary gates remain open.

## Actual updater-process interruption acceptance

- Added a separate-process fixture that executes current TypeScript updater source
  with synthetic signed releases and an isolated temporary installation. Its
  service controller persists simulated loaded state; it never calls launchd.
- Two tests stop at explicit boundaries: after the old service has stopped, and
  after the candidate pointer has activated and its simulated service has loaded.
  Both verify the pending journal and active pointer before issuing actual SIGKILL.
  No catch/finally rollback can run in the terminated updater process.
- A fresh OS process then reacquires the abandoned macOS command lock and executes
  journal recovery. Assertions prove previous pointer/version restoration, paused
  intent preservation, simulated prior service restoration and candidate quarantine.
- This adds real process-death/filesystem/journal evidence beyond hand-written
  journal snapshots. It does not prove actual launchd stop/start, GPU qualification,
  backend enrollment, power-loss durability or every installation/update boundary.
- Only tests changed; candidate-v3 runtime remains the current runtime snapshot.
- Updater focused suite passed all 25 tests after final pre-kill state assertions.
  Typecheck and lint passed for the new harness; scoped formatting and diff checks
  passed. The full suite was not repeated for this test-only batch.

## Replacement diagnostic stream reconciliation

- When a new local spool stream replaces the old stream but the durable outbox
  survives, forwarding now resets only the local cursor and retains the remote
  machine sequence. It rereads the new stream from zero so records below the old
  local cursor are not skipped; a concurrent stream change fails closed.
- Pending old-stream data is replayed unchanged and acknowledged before any new
  stream reconciliation. Tests use two actual isolated spools and verify both
  successful delivery and lost-acknowledgement replay, contiguous remote numbering,
  new local sequence one delivery, durable state and no duplicate next pump.
- Eight focused forwarding tests passed; typecheck, lint, build, scoped formatting
  and diff checks passed. This runtime change postdates candidate-v3 and requires
  a final package rebuild after remaining runtime changes are complete.
- This does not recover a missing outbox after reinstall. The current backend log
  API has no authenticated remote-cursor read exposed to this client; a first
  batch starting again at one can conflict with existing machine diagnostics.
  Missing-outbox reconciliation, live remote receipts and S3 archival remain open.
- Full TypeScript suite after this runtime change: 353 passed, 2 skipped;
  65 test files passed, 1 skipped. Includes the two real updater SIGKILL cases.

## Missing diagnostic outbox recovery across reinstall

- Added authenticated `GET worker/v1/logs/cursor` using the existing UUID session
  query DTO. It reads only the credential's machine, rejects missing/revoked/stale
  sessions, returns the durable acknowledged machine cursor and rejects invalid
  stored values. Legacy missing cursor values return zero. No schema migration or
  production data change is required.
- The production worker requests that cursor only when its durable outbox is
  missing, then publishes its first pending batch above the acknowledged remote
  sequence. A surviving pending batch always replays unchanged without refreshing
  the cursor. Cursor failure creates no guessed batch and defers delivery.
- Backend deployment must precede this worker release. The old backend does not
  expose the new route. Documentation records that rollout dependency and that
  sequence recovery cannot reconstruct deleted log bytes or create S3 archival.
- Backend focused diagnostics: 8 passed. Full unit suite: 812 passed; format, lint,
  typecheck and secret checks passed. Initial `verify` stopped on four auth/security
  HTTP failures. Both affected files passed in an untouched HEAD extraction and
  the current tree (20 tests each); the complete HTTP rerun passed all 140 tests.
  The initial failure is retained here; it was not reproduced or silently counted
  as an initial successful verify run.
- Native backend build and second build passed. Isolated infrastructure recovery
  passed against local MongoDB/Redis. Compiled API/worker authoritative-job
  integration also passed, including cursor zero, append acknowledgement, cursor
  advancement and stale-session rejection using the real authenticated HTTP route.
- Worker full suite before six additional cursor-validation cases: 355 passed,
  2 skipped. Final focused forwarder/client suite: 16 passed. Worker typecheck,
  lint and build passed. Initial added client test fixtures omitted JSON content
  type; correcting the fixtures made the expected protocol checks pass.
- Candidate-v3 predates these runtime changes. No backend or worker deployment,
  live S3 job, remote database mutation, commit or publication occurred.

## Native launchd interruption and rollback fixture

- Extended the updater process-interruption fixture with explicitly opt-in real
  launchd control (`MUSICMUTE_TEST_LAUNCHD=true`). The production controller's
  executor redirects only its service label and plist copy to a unique
  `com.musicmute.recovery-test.<UUID>` label. The installed label is never targeted.
  Each fixture release runs a sleeping process instead of GPU/backend processing;
  qualification remains simulated.
- Both stopped and activated boundaries pass actual SIGKILL plus fresh-process
  journal/command-lock recovery with real launchctl bootstrap/bootout/status.
  Bootstrap waits for running state; recovery restores the previous release,
  paused intent and running service. Finally each test unloads its unique label
  and verifies absence before temporary fixture cleanup.
- Initial native bootstrap returned error 5 because the test plist copy did not
  end in `.plist`. Corrected the isolated filename, added plutil validation,
  and reran successfully. Cleanup accepts absent-service exit 3 or 113 and checks
  absence afterward; other failures remain test failures.
- Opt-in full updater suite: 25 passed. Typecheck passed. Lint identified an unsafe
  explicit throw in test cleanup finally; replaced it with a status assertion.
- No test labels remained after the run. Independent installed status confirmed
  original `0.1.0-mvp.43-local.20260925` still healthy. No production lifecycle
  command, GPU workload, backend call or current-pointer change occurred.
- This proves native service control for synthetic update rollback scenarios,
  not packaged-worker health after rollback, actual install-process interruption,
  unattended startup recovery, power-loss safety or native Windows behavior.

## Installation finalization SIGKILL acceptance

- Added separate-process installation fixtures using current source, synthetic
  local artifacts/enrollment and isolated filesystem state. Actual SIGKILL occurs
  before bootstrap and after simulated service loading but before finalization
  acknowledgement/journal removal. Process termination bypasses normal cleanup.
- A fresh process resumes through the actual `install` CLI without an enrollment
  code. It recovers the abandoned command lock, preserves credential bytes,
  original installedAt and paused intent, and completes finalization. Persisted
  call records prove preparation/enrollment ran once and service bootstrap ran
  once across interruption and recovery, including the already-loaded case.
- Both cases require the pending journal before termination and prove it and the
  saved setup code are removed after recovery. All nine installer tests passed;
  typecheck, lint, scoped formatting and diff check passed. Only tests changed.
- This closes process-death proof for these installation finalization boundaries.
  Enrollment transport, pre-journal enrollment interruption and native installation
  service/GPU/backend health remain separate acceptance boundaries. No installed
  worker, real credential, enrollment code or production backend was touched.

## Latest runtime package and benchmark refresh

- Built candidate-v4 (`0.1.0-mvp.44-reliability.local.20260925.4`, 20096 entries)
  after the diagnostic stream/cursor changes. Source-map upload credentials were
  excluded. Full worker suite: 363 passed, 2 skipped. Build passed.
- Packaged own-Node transfer and guardian fixture checks passed, including
  saturated-input parent death. Candidate and original installed integrity passed.
- Repeated the same 180-second generated fixture with one cold, one warm-up and
  three measured runs. Median 8.802330s; range 8.784660-8.818509s; MPS proven with
  fallback disabled. All outputs retain 180 seconds. Detailed evidence and limits
  are in RELIABILITY-MPS-BENCHMARK.md and benchmark-v4 beside the candidate.
- Original worker was drained/stopped for the run, then independently confirmed
  restored active and healthy on .43. No candidate activation, backend deployment,
  S3 job, capacity change, commit or publication occurred. Native/live acceptance
  and representative/two-slot resource/quality gates remain open.

## Native packaged restart-circuit acceptance

- Ran candidate-v4's actual packaged Node/CLI under a unique temporary launchd
  service label with its own HOME, logs and state. An intentionally missing
  configuration produced real startup failures before engine/backend creation.
  Sentry was explicitly disabled. No test clock, mocked restart budget, shortened
  budget, or production service label was used; launchd throttle remained 10s.
- Real restarts persisted admissions one through five. The next process reported
  budget exhaustion and retained the same PID for 12 seconds, exceeding the
  throttle interval, while the persisted count stayed five. This verifies the
  packaged CLI enters its operator-wait state instead of repeated failed launches.
- Stopped that isolated service, invoked the package's real budget-reset helper,
  verified count zero, then bootstrapped again and observed admission one.
  Finally removed the service and verified launchctl print returns absence (113).
- Evidence and reproducible runner:
  `/Users/hatemragap/.codex/tmp/musicmute-native-restart-dy87iyxu/evidence.json`
  and `run.py`. The process completed with exit 0. Installed .43 local status was
  independently rechecked afterward; no installed lifecycle/config change occurred.
- This closes macOS native packaged failure-budget/quiescence/reset-helper proof.
  Windows service behavior and reset ACLs remain unverified. Successful real-job
  reset, permanent provider faults and production canary scenarios retain their
  separate acceptance requirements; this fixture does not exercise GPU or S3.

## User-requested candidate activation for mobile testing

- User explicitly requested making the new CLI active for mobile tests. Staged
  and verified candidate-v4 in the managed releases directory, preserved .43,
  and used the command lock plus durable update rollback journal for activation.
- Read-only live compatibility probe found GET logs/cursor returns 404. The new
  diagnostic route has not been deployed; remote diagnostic forwarding can defer.
  This limitation was disclosed before proceeding. Mobile processing remains
  independent of asynchronous diagnostic delivery. No backend deployment occurred.
- First launchctl bootstrap returned error 5; the recovery journal restored .43.
  Its health was confirmed before retry. Executable and plist checks passed.
  Retry waited for service unload and included bounded registration retries;
  candidate bootstrap then succeeded. This actual transition exposed a timing
  sensitivity not reproduced by the isolated native rollback fixtures.
- Active version now `0.1.0-mvp.44-reliability.local.20260925.4`. The activation
  runner and an independent fresh status confirmed healthy, modelReady,
  localReady and claimEligible with no blockers. Lifecycle is active and service
  loaded/running. The journal was finalized and .43 remains available for rollback.
- Artifacts: `/Users/hatemragap/.codex/tmp/musicmute-reliability-package-sm0s7fvm/activation-v4/`.
  This is live activation/readiness proof, not proof of a submitted mobile job,
  output listening quality, failure-scenario canary completion or remote logs.

## Live follow-up: backend deployment, input handoff and two-slot test

- Deployed the current backend archive through CapRover as version 59. Build,
  liveness and readiness passed. The authenticated diagnostic cursor changed
  from 404 to 200; the outbox delivered queued records and cleared its pending
  batch. Unauthenticated and stale-session cursor requests returned 401.
- A real mobile attempt exposed a transfer ownership marker left beside the
  input. Python correctly rejected the extra file. The isolated transfer client
  now reclaims the marker after successful helper exit, before returning the
  workspace to Python. Failed/unconfirmed transfers retain their ownership guard.
  The new regression assertion failed before the fix and passed afterward.
- Packaged and activated `0.1.0-mvp.44-reliability.local.20260925.5`. Its real
  packaged download-to-Python directory handoff and upload checks passed. A mobile
  job subsequently completed processing, output upload and backend completion
  at 2026-09-25 10:51:31 UTC. Two earlier resource-check failures remain unexplained
  because their diagnostics reported only the generic SEPARATOR_FAILED code.
- At the user's request, qualified two concurrent workers on the installed .5
  release: baseline 8.580853292s, concurrent wall 11.25738575s, throughput ratio
  1.5244841888801761. The version-2 receipt expires 2026-10-02 11:03:41 UTC.
  This is bounded qualification, not sustained load or listening acceptance.
- Corrected the local `mw` launcher, which still invoked an older global CLI,
  to use the managed current release and its bundled Node. The previous launcher
  was retained. Local launcher/configuration changes are deployment state, not
  repository source changes.
- Enabled two local slots, raised this machine's approved capability and both
  recipe policy limits from one to two, and synchronized policy revisions.
  Backend read-back confirmed two idle slots, applied policy revision 1 and
  claimsAllowed=true. The initial restart failures from capacity/revision
  mismatches were resolved during this change.
- Remaining CLI display issue: remote status wraps local capacity verification
  in a 2.5s deadline; measured local verification took 3.228s, causing a false
  backend-unavailable result. An independent authenticated backend status check
  passed. This display issue is not fixed in this PR.
