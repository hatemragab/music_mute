# macOS worker application integration

Implementation branch: `hatem/macos-worker-app`, based on remote `main`
`bf8eddba12199f0fe8a4c37c3c1575d899936e0b`. Work is local until separately
authorized installation/publication. Existing app accounts, Chrome profiles,
installed workers and machine credentials must not be modified by tests.

## Required outcome

The thin MusicMute app exposes every macOS worker operator capability. An enabled,
paired worker remains a per-user LaunchAgent, starts at login and processes jobs
independently of the GUI. Existing installations retain their machine/slot IDs,
credentials, configuration, lifecycle intent, signed releases and recovery journals.
The CLI remains compatible as a support interface; no npm installation is required
to use the packaged app's controller. Windows and backend wire behavior remain
compatible.

The personal app/Chrome engine remains account-independent and retains the fixed
Kim/MPS/full-timeline recipe, bounded sequential processing and two-minute idle
release. Fleet authentication, claims, leases, transfers and remote control stay
inside the existing Node worker supervisor. New personal work gets the next GPU
turn after accepted fleet attempts finish; it never interrupts an accepted job or
overrides an operator/backend pause. The control service and heavy engine lifetime
are separate. Active fleet readiness is preserved; intentional engine suspension
must not consume crash-restart budgets.

## Local control contract, version 1

The app launches a bundled Node controller over private stdin/stdout pipes. No
shell interpolation, public HTTP listener, user PATH lookup or credential argv is
permitted. UTF-8 JSONL request frames are at most 64 KiB. One command per process;
an explicit subscription process can stream complete local snapshots. Disconnecting
a subscription does not stop the LaunchAgent or cancel its fleet attempts.

Request envelope:

```json
{
  "protocol_version": 1,
  "request_id": "UUID",
  "type": "COMMAND",
  "command": "status",
  "parameters": {}
}
```

Subscription replaces `type` with `SUBSCRIBE` and uses `command: "status"` or
`command: "logs"`, with the same typed log filters as explicit reads.
Each command has a closed, typed parameter allowlist; parameters are mapped to
existing guarded worker functions, never an arbitrary command string. Enrollment
material is accepted only for install and only inside the private request payload.
It is never reflected in replies, diagnostics, errors or operation history.

`adopt` is inspection by default; `apply: true` is the explicit, confirmed move of
an existing paired worker. App update commands accept `source: "app" | "catalog"`.
The GUI defaults to the app-owned service; signed catalog updates remain an
explicit advanced choice. The standalone CLI preserves its catalog default.

Response envelope:

```json
{ "protocol_version": 1, "request_id": "UUID", "type": "RESULT", "payload": {} }
```

Other response types: `SNAPSHOT`, `PROGRESS`, `ERROR`. Error frames carry only a
safe `error_code`; no raw stderr, stack trace, provider response or credential.
Existing CLI JSON payloads retain their compatible worker field names inside the
envelope. Output is bounded and invalid/truncated/foreign-ID frames fail closed.
Subscriptions watch local state/log publications, coalesce events, emit an initial
snapshot, recover file replacement and close cleanly. They do not run recurring
backend status GETs. Worker control-plane reconciliation remains unchanged.

## Operator parity and acceptance ledger

Checked items have implementation and isolated local proof in the evidence table
below. They do not establish installed migration, live enrollment, actual login or
reboot, genuine MPS performance, public distribution or VoiceOver acceptance.

- [x] Status, versions, backend/local readiness and live progress.
- [x] Existing installation adoption; GUI enrollment, label/group and recovery.
- [x] Start/stop/restart/pause/drain/resume with exact prior-intent preservation.
- [x] Job history, errors/explanation, performance and filtered live logs.
- [x] Quick/full Doctor and safe diagnostic export.
- [x] Cleanup preview/apply and managed maintenance state restoration.
- [ ] Qualified capacity and one/two-worker benchmarks.
- [ ] File benchmarks, grouping/runs/warmup, baseline, report/audio exports.
- [x] Signed update check/install and durable activation/rollback recovery.
- [x] Confirmed unpair/uninstall, with separate explicit destructive purge.
- [x] Packaged worker controller/service code and dependencies; thin runtime reuse.
- [ ] Cross-process personal/fleet GPU handover and cancellation/exit safety.
- [x] App/runtime/worker update coordination and referenced-release retention.
- [x] English/Arabic accessible Worker UI and guarded advanced actions.
- [x] Isolated command/subscription/native/process/package tests and builds.
- [ ] Requirement-by-requirement completion audit with actual evidence.

## Contract preflight

The current official [Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-10-06.
Portable rules: 100 (contract first), 104 (authorization boundary), 106
(compatibility), 118 (new envelope property names), 167 (JSON), 177 (safe errors),
200 (private event data). This is local process IPC; public REST URLs, HTTP methods,
status codes, OAuth registry and OpenAPI endpoint registration do not apply.

## Evidence

Record actual checks and their limits here as implementation progresses. Fixture
success is not live enrollment, production processing, release delivery or public
notarization proof. No such production actions are authorized by this task.

### External service distribution

The app carries its controller and a compressed complete worker code/dependency
payload. The payload contains compiled Node supervisor, enrollment, transfer,
recovery, diagnostics and operator modules, the production Node dependency
closure, all Python engine modules and license material. It contains no
interpreter, media binaries, model weights, machine credentials or user state.
Builds use the existing frozen offline production dependency installer and detach
package-store hard links before inventorying. Source maps and type declarations
are excluded from executable payloads.

The service payload has a complete content inventory and digest. Packaging signs
its native Node dependencies in a detached copy before recomputing that inventory
and sealing the ZIP. Installation validates the bounded ZIP inventory, archive
hash, complete expanded contents and native signatures. Code is copied into
versioned MusicMuteWorker releases; no running service executes code inside the
replaceable GUI bundle.

An explicit schema-2 `app-external` release binds that code to one external base
runtime and the fixed model. Schema-1 fleet archives retain their unchanged strict
verifier. The new CLI understands both distributions. An older installed npm CLI
does not understand schema 2; moved workers expose a bundled support CLI instead
of silently modifying a global npm installation.

New release names use a 24-hex prefix of the complete code/bootstrap service
identity. A delivery-policy-only change therefore stages a distinct immutable
release. Existing schema-2 names remain verifiable and unchanged. Tests cover
HTTPS URL/host policy changes, old binding compatibility and reuse across ZIP
transport metadata changes.

Private per-service references below MusicMuteLocal's `runtime/consumers` pin
runtime releases needed by the worker and rollback. Prepare reads them under its
existing exclusive bootstrap lock and refuses pruning when a reference is
malformed, foreign, unreadable or a symlink. The independently copied service
does not hold the GUI update lock for its entire lifetime.

### Local checkpoints, 2026-10-06

These are earlier development checkpoints. The selected package and refreshed
proof are recorded below; genuine MPS and installed migration acceptance remain
pending.

| Check                           | Actual result and scope                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service artifact tests          | 7 passed: isolated executable dependency closure, complete module inventory, tamper/credential/link rejection, compact extraction, detached native signing                   |
| Staged complete production code | 3,746 entries; 34,288,169 expanded bytes after native signing; ZIP 10,149,838 bytes at this checkpoint; final source will be rebuilt                                         |
| Real native dependency          | ARM64 verified, ad hoc signed, strict signature checked after extraction, successfully loaded in isolated Node; no fleet session or inference                                |
| Preserved app regressions       | 7 suites / 500 tests passed for Prepare and playback/recovery behavior integrated from the current main checkout                                                             |
| Full companion suite            | 70 suites passed; 2,096 passed and 4 skipped; one earlier outbox timeout under concurrent full worker/companion load passed in isolation and on the complete companion rerun |
| Engine unit suite               | 102 tests completed with 1 Windows-only skip using the prepared external Python; repository virtualenv lacks Torch; no real model separation benchmark                       |
| Downloader bootstrap            | 25 tests passed with exact prepared pinned wheels; earlier standard-library run skipped 13 wheel-dependent cases and was not treated as full acceptance                      |
| Native checkpoint               | Five suites passed; subsequent Worker/Updater changes recompiled and executed, including private controller pipes and update lease arbitration                               |
| Sparkle branch                  | Swift 6 warnings-as-errors compilation with the actual cached Sparkle framework passed                                                                                       |
| Native appearance               | 16 isolated offscreen PNGs cover eight Worker sections in English/Arabic; no installed GUI, account or Keychain used                                                         |

The primary app checkout is untouched. Its public source changes were integrated
as a snapshot into this worktree; the snapshot and generated evidence stay in
ignored output directories. No real enrollment, installed worker migration,
production jobs, publication or deployment has occurred.

Two product questions were asked during review. Explicit operator enrollment is
the current default. Personal GUI imports retain the current cancel-on-Quit
behavior until the owner asks for durable background ownership; backend worker
jobs remain independent of GUI connections.

### Packaged development checkpoint and acceptance, 2026-10-06

Candidate build `14fe400a-4707-465f-8af3-ca3a37908a4d` / `1791257658` is an
ARM64 ad-hoc signed app of **30,507,817 bytes**. It reuses the existing external
runtime `macos-arm64-v1-c923b1be1f135d8c48ef81c9`, archive SHA-256
`e2ab2504dec4de6dd4bde8b7156bfb7e071bf22b4446a002d30e791ce603a064`.
The service payload has 3,749 inventory entries and digest
`f45c5fc93ca83dcd69d79bbdc4c16ba1eef0ed65641cb7b7389a1dcef9685987`.
The app includes neither the 1.30 GB runtime nor the fixed model weights.

This frozen package predates the later Settings UX and subscription race fixes.
Its receipts validate that artifact; subsequent source checks do not establish
that a newly packaged or installed app has passed the same acceptance. Rebuild
and validate the final package before installed-service migration.

The payload excludes package-manager workspace state as well as lock/store
metadata. A regression test stages identical executable contents with different
validation timestamps and developer paths and requires identical inventory and
payload identity. The actual packaged inventory contains none of those state
files.

Base processing disk accounting is **1,394,763,729 bytes** for one app, one
external runtime and one model. Installing the independent worker adds
**34,382,403 bytes** of expanded service code, making the minimum combined total
**1,429,146,132 bytes**. Retained rollback releases, legacy worker runtimes,
download archives, media, cache and mutable state add further space.

The package is local development evidence: its inherited runtime URL is a
reserved placeholder, Sparkle publisher settings are unconfigured, and it is
neither notarized nor a fresh-consumer/public distribution. No installed app,
worker, account, Keychain, production backend or public release was modified.

| Requirement                                                                   | Current authoritative evidence                                                                                                                                                                                          | Scope / remaining work                                                                                                                                                               |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All 25 worker commands and parameters in native UI                            | `app-control-protocol.ts`, `DesktopWorker.swift`, `DesktopWorkerView.swift`, `WorkerTests.swift`; final native audit                                                                                                    | Native controls and confirmation/request fixtures, including catalog force; no real operator/backend mutations                                                                       |
| Paired adoption, identity/credential/intent preservation, enrollment recovery | `app-installation.spec.ts`, `app-installation-binding.spec.ts`, `macos-user-cli.spec.ts`                                                                                                                                | Actual installer functions with isolated backend/service dependencies; no live enrollment                                                                                            |
| Independent start/stop/restart/pause/drain/resume                             | `macos-user-cli.spec.ts`, `direct-app-coordination.spec.ts`, `worker-runtime.spec.ts`                                                                                                                                   | Shared fences, prior intent and readiness-wait ownership verified                                                                                                                    |
| Job/log/error/performance views and subscriptions                             | `app-control.spec.ts`, `app-control-session.spec.ts`, native Worker fixtures                                                                                                                                            | Filtered actual filesystem publication/directory replacement; package runs both subscription types                                                                                   |
| Doctor, diagnostics, cleanup, capacity and benchmarks                         | Existing guarded CLI functions plus app/native dispatch tests                                                                                                                                                           | Full operator contracts preserved; actual MPS execution below remains pending                                                                                                        |
| App/catalog updates, rollback, killed qualification recovery                  | `macos-user-updater.spec.ts`, `app-installation.spec.ts`, `storage-maintenance.spec.ts`                                                                                                                                 | Canonical catalog tools/plist/support CLI, actual prior release, signed sequence and uncertain-claim refusal verified                                                                |
| Unpair/uninstall and explicit purge                                           | Installer/controller/storage tests                                                                                                                                                                                      | Owned references validated/removed before purge; normal uninstall preserves user state                                                                                               |
| Complete sealed external code/runtime/model binding                           | Final `package-result.json`, 16-check packaged tools proof                                                                                                                                                              | Real ZIP, copied modules/dependencies, native signatures, runtime/model inventories, consumer reference and executed support CLI                                                     |
| GPU admission, warm reuse and cancellation/exit safety                        | `personal-admission.spec.ts`, `worker-admission.test.ts`, engine/process tests                                                                                                                                          | Real socket/process ownership and exit fixtures; resident engine/math unchanged; physical MPS inference/handover acceptance remains pending                                          |
| App/runtime update coordination and retention                                 | Native/Updater tests, installer/storage tests, final package proof                                                                                                                                                      | Actual controller exit precedes lease release; immutable external runtime remains unchanged after qualification                                                                      |
| English/Arabic UI and accessibility                                           | Five native suites, catalog-force fixture, 16 offscreen images                                                                                                                                                          | Local compilation/rendering/requests; no real GUI window or account used                                                                                                             |
| Backend attempt survives controller/GUI-folder removal                        | Checkpoint-payload 52-test package receipt                                                                                                                                                                              | Copied supervisor/guardian and production controller session with an injected status-command adapter; fake inference; no NSApplication Quit                                          |
| macOS launches/restarts the independent service                               | Checkpoint-payload 52-test package receipt                                                                                                                                                                              | Actual RunAtLoad at bootstrap and KeepAlive restart; UUID-only label, exact bootout and all owned PIDs gone; no login/logout/reboot test                                             |
| Build/type/lint/format/test checkpoints                                       | Worker full `pnpm run verify`: 711 passed/21 skipped, 13 packaging tests, 102 engine tests/1 Windows skip; companion full suite: 2,096 passed/4 skipped; native: five suites; final worker package: 52 passed/0 skipped | Full worker pipeline, final companion typecheck/lint/format, final build/package, process tests, 27 MPS safety tests and 11 operator tests passed; genuine inference remains pending |

Generated evidence is deliberately ignored and remains below `output/`:

- `macos/build-14fe400a-4707-465f-8af3-ca3a37908a4d.noindex/package-result.json`
- `packaged-tools-proof/fe74c596-880f-44f7-b329-afcfc6ddc648.noindex/result.json`
- `packaged-tools-proof/fe74c596-880f-44f7-b329-afcfc6ddc648.noindex/worker-package-with-operators-tests.xml`
- `native-worker-acceptance/f1ca5b1e-e0fb-4f18-94a3-70879e1f152d.noindex/acceptance.json`
- `worker-mps-proof.noindex/5db4f2b5-5e1b-494f-a216-fd23930c676c/acceptance.json`

The current 16 offscreen native previews were rebuilt from the existing
`WorkerTests.swift --render-worker-ui` renderer, current shared Swift sources and
English/Arabic strings. Swift 6 warnings-as-errors compilation, strict signature
verification and unchanged source-hash readback passed. The Jobs views show
`Log level` / `مستوى السجل`. These are fixture renders with prohibited application
activation and private HOME/TMP; no real GUI window, account, Keychain, Chrome,
setup, network request or inference was used.

The final default MPS preflight matches this artifact and frozen harness hash
`71b7b048fdc2d465c5c44349fed88c9e6638550be9b05a62f803a8b419882a9f`.
It verified copied assets, exact bundled host-prefix projection and a sandboxed
import with no writes, network or process forks. It generated 12-second stereo
audio. It **did not run inference**, execute the component coordinator, acquire
the real host lock or run host cleanup discovery. The installed
`com.musicmute.worker` was loaded and six possible GPU owners existed.
`preflight_passed: true` is not overall `passed: true`. An approval
request is pending to temporarily drain/stop the installed worker, run genuine
MPS acceptance, and restore its exact prior lifecycle state. Do not infer permission
from elapsed time, disable the ownership guard, stop other applications, or count
this as performance/audio-quality proof. The migration remains incomplete until
its remaining acceptance work is actually proven during an approved test window.

For original capacity/file-benchmark acceptance, the existing local approved
qualification fixture was verified read-only: 2,116,878 bytes, SHA-256
`495012a80265f5ba53d1458c266bb346470c417987dad5048d988a42d182e884`,
regular owner-private file with unchanged identity after hashing. This is current
local byte proof of the historically approved fixture, not a new network/catalog
check or completed benchmark. Original functions must run against a disposable
canonical HOME with synthetic identities, both recipe IDs and real unique-label
service controls. Private HOME alone cannot isolate the hardcoded
`com.musicmute.worker` launchd target. No qualification, capacity change or file
benchmark has executed in that context yet.

The original operator acceptance module is now connected to the parent harness
behind `--operator-acceptance`. Execution also requires `--run-mps`,
`--approve-host-coordination` and an exact `--app` candidate. Default preflight
neither imports nor executes the module, queries its qualification labels, or
acquires the real host update lock. The operator module has no standalone
execution flag and cannot grant its own approval.

Its closed plan dispatches the actual copied one-worker qualification, both
full/trimmed file benchmarks with one warmup and three measured runs, then
two-worker qualification. Capacity changes occur only after genuine passing
qualification. A failed two-worker result retains one worker and an honest
private failure receipt. Every bootstrap uses a fresh UUID qualification label;
the canonical installed label is refused. Pending labels and copied prepared
Python identities must be registered before execution proceeds. Parent cleanup
retains a known qualification process after label removal until its exact live
identity is gone, and releases the host lease only after owned processes and
groups positively exit.

The final 52-test run combines eight artifact tests, six background-service
tests, 27 MPS safety tests and 11 operator-module tests. It includes actual
temporary LaunchAgent bootstrap/restart/bootout with fake inference; the MPS
and operator cases validate gates, ownership, dispatch and cleanup without
real model execution. Final companion typechecking, zero-warning lint over
192 files, formatting and whitespace checks passed. The 34 imported primary
app source files still match their original snapshot hashes. The real installed
worker remained running with PID 3190 throughout these checks.

The selected candidate changes worker control and GPU ownership, not separator
math: its Python separator, pipeline, child and local-engine modules match the
primary source. The current personal app already reuses a resident model for
120 idle seconds when worker-free. With an active fleet coordinator, a personal
request stops fresh fleet claims, waits for accepted attempts and uncertain
claims to resolve, then receives the GPU only after fleet children exit. Its
personal model retires before fleet children reload. Runtime/model files are
shared; converted tensors remain process-owned. Consequently, handover has a
cold conversion/warmup cost that must be measured, and no speedup is yet claimed.

### Drawer Settings shortcut, 2026-10-06

The current native source adds a gear-icon **Settings** entry in the MusicMute
sidebar section. It uses SwiftUI's `SettingsLink` to open the existing Settings
scene, preserving the selected content page and its saved navigation preference.
Existing English/Arabic labels and the shared appearance, language, processing,
storage and updater controls are reused. The row exposes `nav_settings` for
accessibility and UI inspection.

All five `npm run test:native` suites passed. The actual application entrypoint
also compiled with Swift 6 warnings-as-errors for ARM64/macOS 14, and strict
Swift formatting and whitespace checks passed. Build-only evidence is
`output/settings-drawer.noindex/c761c57f-bf54-454d-8368-913c9766bb39/build-result.json`.
No application was launched or installed and no user settings were changed.
The frozen 14fe package and its earlier UI previews predate this source follow-up;
they do not prove the new Settings row is present in an installed app. A subsequent
package must include this source before installation acceptance.

### Settings layout and behavior, 2026-10-06

Settings now uses native Appearance, General, Storage, Shortcuts and App updates
tabs with a stable window size and independent selected-tab state. Updates are
inside their scrolling pane instead of a fixed footer competing with the form.
Appearance/accent selections have full hit regions, selected indicators and
local 180 ms feedback that respects Reduce Motion; preference persistence and
System appearance behavior remain immediate.

The text-size modifier keeps a stable content hierarchy across System/custom
changes. Native measurement exposed that macOS semantic fonts did not visually
respond to the previous DynamicTypeSize-only setting. Explicit native font
scaling now handles Settings body/headline/caption/control text, while inherited
body text also receives the app-level scale. The latest probe measured body
System/Compact/Accessibility sizes of 92x18, 80x14 and 133x24 points, and headline
sizes of 96x16, 84x14 and 139x24. Both mounted state identities remained stable.
Explicit fonts elsewhere in the app are outside this Settings font migration.

Storage now normalizes bounded Unicode decimal digits, including Arabic input,
without accepting fractions, signs or overflow. A window-owned single-flight
loader settles even if its presenting tab's task is cancelled. Failed or unknown
loads expose Retry and disable mutation; drafts survive external budget updates
and tab changes. Busy state includes the private native bridge, and successful
clear counts are semantic/localized state. The input displays one localized GB
unit, and usage formatting follows the selected app locale without English zero
phrases in Arabic.

Updater availability now observes Sparkle's documented KVO readiness on the main
queue. Its automatic-check control requires a successfully initialized service,
and failed startup removes the unusable service/observation. Isolated readiness,
startup failure and weak lifetime fixtures passed both without Sparkle and with
the cached actual Sparkle 2.10.0 framework; no live feed was contacted.

All six `npm run test:native` suites passed after the functional changes. The
final two display-only storage fixes then passed the scoped Settings suite and
actual application compilation with Swift 6 warnings-as-errors. Strict Swift
formatting, JavaScript lint/formatting, translation plist lint and whitespace
checks passed. Fourteen real-view offscreen previews cover English/Arabic,
light/dark and large text. Native tab-header pixels are compositor-backed and
cannot be validated by these offscreen bitmaps; no visible window, installed
application, account, cache or worker service was changed.

Current source-only evidence:

- `output/settings-ui-proof.noindex/427f407c-9f39-4fb4-a3c1-5da2cfd1ba37/acceptance.json`
- `output/settings-app-build.noindex/6197f0db-352d-422e-a8a3-54bd490735d5/build-result.json`
- `output/updater-readiness-proof.noindex/d3772ba7-375f-4a1b-84c8-9d0d6614172c/`

These follow-ups are not present in the older frozen 14fe package. New packaging
and installed UI acceptance remain separate from these source/build/fixture
checks and from the still-pending genuine worker GPU acceptance.

### Source merge validation follow-up, 2026-10-06

Local snapshot subscriptions now fence cancellation after asynchronous directory
inspection, recover directory disappearance between inspection and watch
registration, and ignore errors from a retired watcher. Only `ENOENT`/`ENOTDIR`
registration races are retried; unsafe paths and permission failures remain
terminal. No periodic polling was added. Eight deterministic regression cases
cover these races and safety checks; the focused suite passed all 19 tests.

The supervisor replacement test now explicitly terminates its deliberately
resident replacement during cleanup before confirming process-group exit. Its
one-second bound and original termination assertions remain, and cleanup failures
retain the underlying child error. The focused suite passed all four tests. The
original CI failure was not reproduced; this removes a confirmed unnecessary
shutdown wait without changing production process supervision.

Fresh post-rebase `worker/pnpm run verify` passed: 719 tests passed/21 skipped,
13 packaging checks passed, 102 engine tests ran with one Windows-only skip, and
protocol, formatting, lint, type checking and build passed. Post-rebase
`chrome-extension/npm run verify` passed with 2,096 tests passed/four skipped,
type checking, lint, build and formatting. These checks validate source and owned
fixtures; the frozen package checkpoint and pending installed/GPU acceptance
retain their separate scope.
