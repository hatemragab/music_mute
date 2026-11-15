# W17 — Port listening history and playback-session accounting

- Status: code-complete / Windows pending. History persistence, captured playback ownership, live Library metrics and recovery controls have source/headless evidence.
- Code dependencies: [W14](W14-complete-account-experience.md), [W16](W16-complete-library-and-metadata.md).
- Accepted scope points: P13.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [history core source and fixtures](../evidence/W17-history-core.md).

A dependency's pending Windows checks do not block this task's code work. Implement real native source now, test portable behavior on the Mac, and retain native checks for W34.

## Existing behavior and design consequence

Listening history is a product behavior, not a counter attached to every play/pause event. Counts must remain owner/device scoped and resistant to duplicate media events, seek and source switching.

## Read before editing

- [chrome-extension/macos/DesktopListening.swift](../../../chrome-extension/macos/DesktopListening.swift)
- [chrome-extension/macos/DesktopWorkspace.swift](../../../chrome-extension/macos/DesktopWorkspace.swift)
- [chrome-extension/macos/Tests/DesktopTests.swift](../../../chrome-extension/macos/Tests/DesktopTests.swift)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Trace and document the current macOS start/repeat/AB-loop counting rules and persistence schema, then port them to a typed shared or Windows domain model.
- [x] Create durable device/owner-scoped history records with stable media identity and logical playback-session IDs. Count genuine starts and intentional repeat/AB repeat as specified.
- [x] Exclude pause/resume, seek, buffer recovery, original/voice switch and duplicated player events from new-play counts. Preserve most-played sorting and last-listened metadata.
- [x] Fence account switches and delayed events so history cannot move to another owner. Preserve signed-out local history under its intended local scope.
- [x] Make writes atomic/bounded and recoverable after crash; define migration/version handling and deletion behavior without silently resetting or combining histories.

- [x] Bind current account/device scope, Library alias metadata and Most Played/recovery controls into the main/renderer composition.
- [x] Subscribe Library metrics to durable count/alias changes, update Most Played immediately, and keep metric updates free of catalog reads, HTTP requests and thumbnail refetches.
- [x] Provide `accountingFor` from trusted track ownership: guest/local playback stays in the Windows-user partition through account changes; account playback retains its captured generation and refuses a later begin after retirement.

## Code validation checklist

- [x] Run event-sequence/property tests for starts, pause/resume, seeks, buffer stalls, source switches, repeats, AB loops, duplicate end events and crash/relaunch.
- [x] Test account A/B/signed-out transitions and device identity changes against most-played sorting.
- [x] Verify bounded persistence, damaged-history recovery and idempotent repeated event delivery.
- [x] Test guest playback/repeat across A→B/sign-out, independent guest/account recovery state, live Library reordering, no refresh IO and subscription disposal. See the dated continuation in evidence.

## Windows acceptance — deferred until W34

- [ ] Compare real player event sequences and visible counts on Windows across source switches, loops and resume.
- [ ] Verify history persists correctly across app/OS restarts and owner changes.

## Detailed agent execution handoff

### Counting contract and remaining composition

Existing source: [history controller](../../../windows-desktop/src/main/history/controller.ts), [durable store](../../../windows-desktop/src/main/history/store.ts), [history model](../../../windows-desktop/src/main/history/model.ts), [playback controller](../../../windows-desktop/src/main/player/controller.ts) and macOS [DesktopListening](../../../chrome-extension/macos/DesktopListening.swift). The core counts a genuine start/repeat, not every player event. Windows-user/device-local scope and each account UID partition remain distinct; a generation fence owns every asynchronous publication.

- [x] Bind one trusted accounting adapter to the actual player. `begin(trackId, sessionUUID)` counts once; `pulse(trackId, sessionUUID, logicalSeconds, rate)` records bounded logical progress; `end` finishes that incarnation. A pause/resume, source/voice comparison switch, seek or buffering recovery reuses its UUID.
      Capture `HistoryController.accountingFor({id,jobId?,title,accountOwned})`
      once from the trusted Library descriptor for that playback session. Do not
      select the current account again at a later repeat/A–B begin. The returned
      port also rejects a different track ID. Account-owned media needs a fresh
      valid account capture; local media uses constant Windows guest authority.
- [x] Use a fresh UUID only for an actual successful new start, repeat or A–B replay. Wait for the confirmed seek boundary/generation before counting an A–B loop; a duplicate timer/media boundary must not count twice.
- [x] Bind Library stable aliases and most-played sorting. Source titles and local/account aliases are presentation/association, not identity permission. Merge duplicate identity aliases according to existing max/count rules rather than summing the same play twice. `subscribeCounts` changes cached metrics without polling; `canCount` isolates an unavailable partition from usable media and the other partition.
- [x] Apply account scope before Library/player updates. Retired accounting ports ignore late pulse/end and refuse a new begin; an owner change alone must not manufacture a new play. Account-owned playback capabilities retire promptly. Continuing guest playback preserves the Windows-user local lifetime without crediting a new account.
- [x] Wire restore/flush/clear/recovery controls and close lifecycle. Count writes are durable immediately; progress is coalesced and flushed on meaningful boundaries. A post-rename uncertain acknowledgement must be read back rather than incrementing again.
- [x] Preserve primary/last-good integrity checks, unknown-schema refusal and explicit recovery of damaged history. Clear affects its exact selected partition/copies; removing a Library row is not authorization to erase unrelated history or account data.

### Faults and acceptance

Test start→pause→seek→voice switch→resume, repeat, A–B confirmed seek plus duplicate boundary, deleted/aliased Library entries, unchanged alias reattachment, invalid duration/rate/progress, stale UUID pulse, account A→B during write and detached dirty A progress after a newer committed count. Fault primary write/rename/acknowledgement and backup corruption separately. Verify retained UUID/count/alias capacity is bounded and a full ledger refuses safely rather than evicting deduplication proof and double-counting.

Run focused history/controller/store/playback tests with the real headless player, strict typecheck/build and scoped lint/format. Existing 27-test accounting evidence is core proof; final Library/UI/owner-switch composition must be recorded separately. Deliver counting examples, persistence/version/limit behavior and composed player/account tests. W34 later checks real Windows restart, media-event timing, repeat/A–B and account switches with designated media; synthetic events do not prove the native player timeline.

## Restart, Next and variant count boundary

- [x] Restart seeks to zero without opening a new listening/count event. Distinguish
      manual Next, natural ended/repeat, selected queued Play and variant switch.
- [x] Count only matching actual playback/seek completion under existing rules;
      command acknowledgement, paused source switch or duplicate ended does not
      create a play. Test each transition with original and voice sources.

## Completion record

- Implementation files and review: `src/main/history/`, safe history contracts and three focused test files; Mac counting/persistence/sorting rules traced in evidence.
- Commands/results and evidence: the original 27-history/391-desktop rows are historical. At 21:57:32 on 2026-10-09, the history/controller/store/player, live Library metrics and listening integration subset passed 81 tests in six files. Current desktop TypeScript, lint (435 files, zero findings), owned formatting and both bundle boundary checks passed. See the dated source closure in [history evidence](../evidence/W17-history-core.md).
- Unrun native/toolchain checks: private Windows file ACL/disk behavior, real media event/UI counts and Windows restart acceptance remain W34.
- Remaining limitations and next task: Library metric and captured player composition now have headless source evidence, including guest repeat counts across account changes. Real Windows event/UI and restart checks remain. Explicit bounded-ledger capacity and schema behavior are recorded in evidence. W20 outbox follows.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
