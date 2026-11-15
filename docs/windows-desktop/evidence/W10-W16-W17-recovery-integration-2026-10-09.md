# Worker recovery, Library and history source integration

Date: 2026-10-09. Host: macOS ARM64, Node 24.18. These are source builds,
temporary fixtures and headless DOM tests; Electron, Windows native helpers,
DirectML, installer, browser, OAuth and real account/storage acceptance are unrun.

## Production composition

- Main inspects both protected updater and fleet-requalification journals before
  launching a session. Missing account configuration cannot bypass either fence.
  A valid fleet-only pending journal permits genuine Prepare; corrupt state
  remains fenced. Cold headless Chrome account startup never starts Prepare.
- The actual Prepare promise/lease settlement requests existing-fleet recovery.
  Idle activity and admitted-command events schedule it without status polling.
  Recovery owns a separately pinned native helper and a passive SessionClient;
  it does not launch an old supervisor to manufacture readiness.
- `createDesktopFleetRecoveryActivity` uses the existing DesktopMaintenanceGate.
  It closes idle Browser authority only after verified session retirement and
  defers committed gate clearing until the coordinator releases its lane and the
  command/journal truly settles. Failed/uncertain retirement retains its fence.
- Main retains a separate rebind fence after old supervisor retirement. Local
  handle-close, native-close or replacement failure cannot reopen intake. The
  trusted internal rebind must establish real session/personal/browser/updater
  handles before clearing it; clear-journal retry resumes settlement without a
  new Prepare/model run. A coordinator with retained cleanup still resumes its
  genuine run rather than being mistaken for completed settlement.
- A localized worker recovery banner provides the existing Prepare retry only
  when trusted Main state permits it. Active recovery and malformed journals
  expose no bypass. Ordinary GUI uninstall preserves the independently retained
  worker Run entry; explicit Worker Remove remains separate authority.
- Account Library DELETE calls its retirement hook only after server ACK and an
  unchanged captured owner/epoch. Main stops only that currently selected track.
  Rejection or a late A reply after B cannot retire B playback. Local copies,
  source media, shared originals and other items are not implicitly purged.
- W17 actual application history capture, durable guest/account partitions,
  live Most Played and recovery controls are code-complete. The task index checks
  implementation/code validation separately from still-unrun Windows acceptance.
- Window keyboard handling reads the latest rendered snapshot and
  synchronous admitted-action count, avoiding stale passive-listener closures.
  No listener replacement occurs for every playback time snapshot.

## Checks actually executed

| Check                                                               | Result                             | Scope                                                                                                                                       |
| ------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Library/preparing/localization/recovery-navigation subset, 21:52:29 | 45 tests / 6 files passed          | ACK/owner fencing, preparing cancellation/progress, locale and recovery UI                                                                  |
| Fleet recovery/gate/headless recovery UI subset, 21:56:00           | 28 tests / 5 files passed          | Real coordinator/maintenance helper with injected native/consumer ports; no Main/Electron execution                                         |
| History/Library/listening composition, 21:57:32                     | 81 tests / 6 files passed          | Captured counts, owner changes, durable faults, live sorting, actual domain controllers                                                     |
| Keyboard/preparing/recovery/localization, 22:01:02                  | 39 tests / 5 files passed          | Includes corrected current-snapshot event routing and busy suppression                                                                      |
| Static accessibility, 22:03:21                                      | 14 tests / 1 file passed           | Seven composed routes in English/Arabic, Library deletion dialog, named semantic controls and password labels; headless DOM                 |
| Desktop TypeScript, full lint, source build, owned formatting       | Passed                             | Lint checkpoint: 435 files, zero warnings/errors; source was still receiving later fleet/bootstrap edits                                    |
| Renderer/preload package boundaries                                 | 2 tests passed                     | Self-contained renderer, restricted typed preload; no native package/signature proof                                                        |
| Full desktop regression, 21:59:30                                   | 1,389 passed / 2 failed, 172 files | Keyboard stale-snapshot failure subsequently fixed and focused tests passed; Doctor/current-GPU failure remains under its owner until rerun |

These counts overlap and must not be added. A focused pass does not replace the
required final combined regression. Later source edits require their own checks.

## Remaining code and native gates

Finish approved-secondary GPU selection and genuine PERSONAL/fleet alignment
under the existing Prepare/session/GPU fences. Finish bootstrap/package/current
Doctor fixtures and the final combined regression/task audit. The independent
login bootstrap already has source fixtures for retained capsule/peer identity
and saved running/paused/draining choices; installed Windows proof is separate.
W28's broader modal/interactive audit and Windows Narrator/DPI/font rendering
remain open beyond the fourteen recorded static DOM cases.

The [official Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-10-09 for the additive trusted recovery snapshot. Applicable
portable rules preserve authenticated authority, compatible extension (106/109),
safe errors (177), bounded validated data and sensitive-event exclusion (200).
The existing local IPC naming stays compatible; HTTP/OpenAPI-specific transport
rules do not apply to this Electron bridge. No public REST route was changed.

No commit, push, deployment, publication, signing, live enrollment or real-user
data deletion occurred. Windows 10 22H2 x64 and Windows 11 x64 acceptance remain W34.

## Existing controls and later regression — 22:14

`openDesktopSessionClient` still verifies the pinned native/launcher, private
bootstrap/config hash, actual same-logon process ticket and responding release.
It now applies GPU Ready/boot validation before a **new launch**, allowing
existing authenticated Stop/Pause/Drain controls to attach despite missing/stale
personal readiness. Four portable real-function orchestration fixtures passed
at 22:14:15: existing attach performs no Ready read/model work/launch; absent
passive attach refuses; a reused PID cannot become existing authority and new
launch requires Ready; mismatched responding release refuses. Native transport,
status and filesystem-private reads are injected; no Windows executable ran.

The full run at 22:14:45 passed **1,413 tests** and failed **seven** in 174 files.
All failures were in login-worker fixtures while new positive Prepare-tree and
cleanup-uncertainty ports were being integrated. TypeScript identified the same
missing binder/fixture ports. Other earlier full failures are corrected, but the
whole tree remains unvalidated until that slice settles and the full rerun passes.

## Stable combined checkpoint — 22:19

At 22:19:16, `npm test -- --maxWorkers=2` passed **1,424 tests in 174 files**
in 32.87 seconds. `npm run typecheck`, `npm run lint` (437 files, no findings),
`npm run format:check`, `npm run build` and both `npm run test:package-fixtures`
checks passed. The earlier full failures above are resolved. This checkpoint
includes current DXGI/boot evidence, genuine approved-secondary PERSONAL/fleet
alignment, uncertain-cleanup retention and the independent logged-in bootstrap.
It remains source/headless proof, with native C++/Windows operation unrun.

The W28 follow-up found modal focus/default-dismiss behavior still needing source
closure. Its edits land after this checkpoint and require focused validation;
do not extend this whole-suite pass to those changes without a later result.

## Latest combined checkpoint — 22:43

`npm test -- --maxWorkers=2` passed **1,476 tests in 179 files** at 22:43:50
in 36.64 seconds. TypeScript, full lint (444 files, zero warnings/errors) and
full formatting passed. Source build and both package-boundary fixtures passed
again during the subsequent status review. These are Mac source/headless checks;
no Electron UI or Windows executable was launched.

This checkpoint covers the [W28 composed modal/keyboard audit](W28-composed-accessibility-2026-10-09.md),
the actual restricted preload/production IPC ingress/UI transport fixtures and
the [seven composed Cloud I/O cases](W13-composed-cloud-io-2026-10-09.md).
The earlier W28 issue is resolved. Cloud file input now positively releases its
prepared workspace before result download acquires that same request workspace;
uncertain cleanup or a changed account owner still refuses adoption.

After this full run, the fourth `desktop-ipc-transport` case was extended with
an account-owned queued action revoked at sign-out while guest playback survives.
All four transport tests passed at 22:45:48. They run the source-built preload,
production ingress, actual UI and playback controller; a trusted account-owner
event and native media ports are injected. The fixture does not compose a live
AccountController or establish real OAuth/native playback.

W17 and W28 detailed source/code checklists are complete; their Windows checks
remain open. Overall production-entry, requirement and task closure review still
continues. Native compilation, actual DirectML, installer/signing, Chrome,
authentication, Share, login/logout and Windows UI acceptance remain W34.
