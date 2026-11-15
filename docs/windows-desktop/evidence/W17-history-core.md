# Evidence: W17 — Listening history and playback accounting core

- Date: 2026-10-09.
- Host: macOS arm64; Node 24.18.0, TypeScript 6.0.2, Vitest 4.1.11.
- Status: code-complete / Windows pending; the dated closure below supersedes older pending application-binding claims.
- Scope: `windows-desktop/src/main/history/`, `src/shared/history-contracts.ts`, `tests/history*.ts`.

## macOS reference and Windows behavior

`DesktopPlayHistory` in `DesktopWorkspace.swift` persists `desktop.play-counts.<SHA256(owner)>` dictionaries in device preferences. Signed-out owner is `local`; signed-in owner is the Firebase UID. Cache and job IDs alias the same song. Linking histories uses the maximum prior count, never their sum. Most Played orders by descending count, then localized title and stable ID. The workspace counts only a ready AVPlayer actually playing. Pause/resume, seek, buffering and original/voice comparison retain the counted flag. Confirmed track repeat and successful A/B seek while playing clear that flag and count again. These rules are covered by the existing macOS reference tests around `libraryPlayHistoryChecks` and queue playback.

Windows `HistoryController` implements the real player `begin/pulse/end` port. One UUID is one genuine start; duplicate begins and end events remain idempotent across reopen. Repeat/AB use another UUID only after the real player confirms a new start/seek. Alias reconciliation preserves max counts without creating plays. Counts saturate safely; last-listened date/progress remain local. Continuous logical audio seconds are recorded separately from play counts. Backward seeks, large jumps, delayed buffer callbacks and rate transitions establish a new baseline and cannot fabricate listened progress.

Storage is separated by actual Windows SID, installation UUID and local/Firebase owner, using SHA-256 directory keys. Account generation is a callback fence, not another persisted owner. A generation change clears the view before reading its separate ledger. A captured accounting port rejects old-owner events. In-flight writes keep their original directory; detached progress cannot overwrite a newer count committed during account switching. Repeated presentation updates of the same account generation do not invalidate the player port.

`WindowsHistoryStore` uses private ACL-validated atomic files through existing Prepare private-file primitives. A checksum/strict versioned schema binds each record to device and owner. Primary and last-good copies are independently validated. Damage exposes the last-good data read-only with explicit recovery, preserving the damaged original. Unsupported versions are not downgraded. Explicit Clear blanks primary, backup and recovery copies; Library media deletion is independent and does not clear play counts. Counts commit immediately, progress writes coalesce for five seconds and flush on end/scope transition/quit. A failed post-rename check reads back the same owner before retry, avoiding a second count.

Bounds are explicit: 4096 grouped identities, 8192 bounded Library metadata identities, eight aliases per group, 8192 persistent UUID receipts and two MiB. At capacity the controller reports `HISTORY_CAPACITY_REACHED`; it does not evict dedupe receipts or silently reset counts. Increasing/archiving this limit needs a deliberate future retention design. No macOS preference file is migrated into Windows; this new Windows store begins at schema v1 and preserves unknown versions for a future migration.

## Executed checks

| Command / `windows-desktop`                            | Result                      | Proof boundary                                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/history*.test.ts`                | 27 tests / 3 files passed   | Event sequences, real PlaybackController/AdvancedListening composition, owner/device transitions, crash/reopen, uncertain commits, aliases, bounds, strict schema and damaged recovery. |
| `npm test`                                             | 391 tests / 46 files passed | Historical integrated source/headless checkpoint; no UI or native execution.                                                                                                            |
| `npm run typecheck`                                    | Passed                      | Strict desktop source types.                                                                                                                                                            |
| Scoped `oxlint --deny-warnings` and `prettier --check` | Passed                      | Owned history files, no lint findings.                                                                                                                                                  |
| `npm run build`                                        | Passed                      | Source bundles only.                                                                                                                                                                    |

## Remaining integration and Windows acceptance

Application playback capture and recovery/clear UI remain integration responsibilities. The source composition tests exercise the actual player and history implementations but do not establish a running Windows app, disk ACL behavior or visible Library counts. Windows restart, actual media events across source switches/loops and designated-owner acceptance remain W34. No production account, private user media, deployment or permission changes occurred.

Next task: W20 durable background account saving/outbox core.

## Live Library metrics and captured guest authority continuation

At 19:00:55 on 2026-10-09, the history/controller/store/playback, Library controller
and personal runner/controller/reuse command passed **73 tests across seven
files**. Strict desktop TypeScript and the seven-file scoped lint passed. This is
a current source slice; the earlier 391-test full-suite row is a historical
snapshot and is not reclassified as current integration acceptance.

`HistoryController.accountingFor` takes trusted Library `accountOwned` metadata
and registers the validated stable track/aliases. Its returned port is bound to
that exact track. Local media captures the independent guest actor and remains
local through account A→B, sign-out and later repeat starts. Account media
captures the existing generation fence: retired begin refuses, late pulse/end
does not affect a new account. The legacy unclassified accounting API preserves
its current-scope semantics; the application must use the explicit ownership
API for playback. Signed-out account-owned capture is refused.

`subscribeCounts` emits after durable count or alias changes and availability
changes, without emitting for ordinary listened-progress pulses. Library
subscribes, recalculates cached `playCount`, and immediately reorders Most Played
without catalog/cache reads, HTTP or thumbnail requests. A missing/corrupt guest
history no longer prevents valid account metadata reconciliation; `canCount`
keeps unavailable partition counts separate from Library media usability.
Library disposal detaches the count subscription. Fixtures use the actual
HistoryController, LibraryController and durable in-memory file port; they do
not simulate a successful Windows native player.

The application still has to capture this port from the actual resolved Library
row once per successful playback session, retain it across original/voice
switches and confirmed repeats/A–B seeks, and retire it when that playback
session ends. A later account lookup cannot replace a guest session's authority.
The corresponding main/UI integration and W34 real media-event checks remain
unchecked.

## Application source closure — 21:57, 2026-10-09

The earlier application-binding gaps above are historical. Main now supplies
`LibraryPlaybackSources.accountingFor` from the actual verified artifact's
`accountOwned` flag and captured Library metadata; the player retains that port
across original/voice switching, repeat and confirmed AB seeks. Guest listening
uses the constant local installation actor. Scope changes begin account playback
retirement and clear the old Library/history view before awaiting slow teardown.
Main subscribes history and Library snapshots, and the existing history UI binds
clear/recovery to the exact selected partition. These are actual source bindings;
Electron itself has not been launched on this development Mac.

At 21:57:32, the six-file history/controller/store/playback, Library controller,
listening and headless listening-player subset passed **81 tests**. It covers
guest/account switches, duplicate starts/ends, captured repeats, aliases, live
Most Played without refetch, damaged/unknown schemas and bounded persistence.
Desktop `npm run typecheck`, full lint (435 files, zero warnings/errors), owned
Prettier and both renderer/preload bundle boundaries passed. The prior whole-suite
checkpoints remain scoped to their recorded source snapshots.

All W17 source and executable code items are complete. Windows file ACL/native
disk behavior, actual player event/count timing, visible UI and OS restart are
still unchecked in W34. No Windows, account, backend or R2 acceptance is implied.
