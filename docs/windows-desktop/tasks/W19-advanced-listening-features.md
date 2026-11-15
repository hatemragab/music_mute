# W19 — Implement sleep timer, AB loops, bookmarks and silence skipping

- Status: code-complete / Windows pending.
- Code dependencies: [W18](W18-player-and-playback-queue.md).
- Accepted scope points: P15, P24.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [whole W19 source/authority/proof ledger](../evidence/W19-2026-10-10-closure.md) and [historical/capacity checkpoints](../evidence/W19-listening-core.md).

Handoff boundary: checked rows preserve earlier source evidence. Execute source
work only when implementation is explicitly authorized. Windows machine checks
remain separate and do not block code-only development on the Mac.

## Existing behavior and design consequence

Advanced listening features depend on logical media time, not only the browser audio element's current time. Silence skipping must not corrupt original/voice comparison or the untrimmed Chrome synchronization recipe.

## Read before editing

- [chrome-extension/macos/DesktopListening.swift](../../../chrome-extension/macos/DesktopListening.swift)
- [chrome-extension/macos/DesktopWorkspace.swift](../../../chrome-extension/macos/DesktopWorkspace.swift)
- [chrome-extension/macos/DesktopPreferences.swift](../../../chrome-extension/macos/DesktopPreferences.swift)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Port and validate the bounded timer/AB/bookmark/silence domain, typed UI controls, DPAPI preference adapter and fixed owned CPU analysis source.
- [x] Complete real main/Library/player/history composition and offline analysis acquisition before closing the full product items below.

- [x] Port sleep timer setup, remaining-time display, cancellation and expiry behavior; account for system sleep and clock changes through a documented time model.
- [x] Implement AB markers, validation, clear/reset, looping and repeat count integration. Handle short/invalid ranges, end-of-media, rate changes and seeks outside the loop.
- [x] Implement bookmarks and their rename/delete/navigation behavior with stable media/owner identity, persistence and source-switch consistency.
- [x] Port silence detection/skip controls and saved preferences, with bounded analysis and recoverable preparation. Use an explicit original/output/logical timeline mapping.
- [x] Preserve untrimmed source/result identity for browser synchronization. A desktop listening preference must not mutate cached audio or silently change the shared processing recipe.
- [x] Define interaction priority among sleep timer, AB loop, repeat/shuffle, manual seek, source switching and queue advancement. Stop stale callbacks on media/owner generation changes.

## Code validation checklist

- [x] Run the source checkpoint's clock, generation, repeat, bookmark, PCM, strict result-binding and cleanup fixtures with TypeScript, scoped lint and source builds.
- [x] Fence listening commands at accepted media/owner generation and position before preference reads; retire analysis as a replacement starts, including the interval before its source is ready.
- [x] Preserve a timer selected during source preparation through Ready and same-track restart/comparison, while cancelling it when a different track starts.
- [x] Recheck actual source/timeline/generation after awaited playback accounting and listening work so late `time`, repeat `seeked` and ended callbacks cannot affect newer playback.
- [x] Exercise actual PlaybackController + PlayerPanel command/media-event binding for pending-source sleep, delayed bookmark ownership and sleep-before-AB-before-silence priority with injected clocks/media; preserve guest bookmarks through account changes.

- [x] Test fake-clock sleep expiry, clock/sleep jumps, AB boundaries/repeats, bookmarks after source switches and corrupt preference recovery.
- [x] Test silence-map boundaries, variable rate, seeks near cuts and logical/original/output time conversions, including empty/all-silent media.
- [x] Verify logical repeat counts and that enabling listening features leaves cached artifact/recipe identity unchanged.

## Windows acceptance — deferred until W34

- [ ] Listen and verify timeline behavior for silence skipping, AB, bookmarks and original/voice comparison on real Windows audio.
- [ ] Test timer expiry during background playback, lock and sleep/resume without unexpected queue advancement.

## Agent execution contract — planning review 2026-10-09

Use `AdvancedListening`, the current bookmark store, streaming PCM detector,
fixed verified `silence_analyze` Prepare operation and owned analysis runner.
The current main composes them with Library/player/history; revalidate final
scope/persistence/lifetime behavior rather than adding another preference store.

| Feature  | Invariant and persistent identity                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sleep    | Preserve current Mac policy: a different-track start cancels the timer; same-track/source changes retain it. Remaining cannot increase after backward clock changes. Expiry stops before advancement; Quit cancels ownership. |
| AB       | Verified original logical coordinates where comparison exists, otherwise explicit standalone voice-output basis; minimum 0.1-second interval and matching seek/generation before repeat accounting.                           |
| Bookmark | Stable installation/SID + owner/media/artifact and coordinate basis; up to 100, duplicate tolerance 0.5 seconds, bounded DPAPI record and fenced writes.                                                                      |
| Silence  | Playback seek preference over a verified exact source/result identity and analysis version; never rewrites cached media or changes browser processing recipe.                                                                 |
| Analysis | Owned fixed CPU decode/probe task, not model inference/qualification; private scratch and exact source pin retained through actual process-tree cleanup.                                                                      |

Current detector mirrors the traced Mac constants: 1,024-frame blocks, RMS
`0.00316227766`, quiet run at least 0.4 seconds and 0.06-second edge padding.
Bounds are one/two channels, 8–192 kHz, up to two hours/10,000 ranges and bounded
streamed chunks. These values are source parity, not an assertion of listening
quality. Preserve the shared analysis version when reusing a result.

### Implementation order and boundaries

1. [x] Review native Mac behavior, `listening.ts`, bookmark-store,
       silence-analysis/child/runner and the renderer controls. Ensure timer/AB/
       bookmark/silence commands act through the existing PlaybackController.
2. [x] Close timer wall/monotonic/resume reconciliation and display cancellation.
       Remaining is bounded by prior remaining, wall deadline and monotonic elapsed;
       lock/background/resume is not a new timer ownership scope.
3. [x] Close AB setting/clear/navigation/manual-seek/source-switch interaction
       and repeat history. Actual matching seek completion, while playing, is the
       count trigger; a command acknowledgement or duplicate callback is insufficient.
4. [x] Review bookmark/silence preference persistence for guest/account identity,
       serialized concurrent edits and A→B/relaunch. Preserve damaged record bytes
       for explicit recovery; do not silently reset corrupt preferences into success.
5. [x] Close offline exact Library acquisition/pin/hash/staging for silence
       analysis. Use the verified fixed CPU operation; no model load, GPU qualification
       claim or arbitrary FFmpeg command from renderer. Keep launch/shutdown-unknown
       scratch protected until the native ownership certificate settles.
6. [x] Validate detected ranges against actual chosen-source duration and map
       them through original/output/logical time. For trimmed media, preserve W18
       retained sample-map semantics; empty/all-silent and missing-map cases have
       explicit behavior. Manual seek and source switch reset stale skip callbacks.
7. [x] Document and enforce priority: timer expiry first, AB boundary next,
       eligible voice silence skip next, normal ended/repeat/queue advancement last.
       W17 counting observes actual playback/seek events; cache/recipe hashes never
       change when listening preferences are toggled.
8. [x] Close W22 pins/scratch and W29 maintenance/quit coordination. Cancellation
       ends only this owned analysis; it cannot kill unrelated inference/worker trees.

### Code-only fixtures and faults

- [x] Fake wall/monotonic clocks: forward/backward jumps, resume after deadline,
      expiry exactly at AB/end, queue changes, cancellation, quit and stale timer
      generation. No unexpected next-track start after sleep expiry.
- [x] AB short/inverted/out-of-duration ranges, rate changes, seek outside loop,
      source switch, duplicate boundary/seeked callbacks and old revision; count once
      only after the actual matching replay begins.
- [x] Bookmark duplicate/tolerance/max count, rename/remove/navigation, owner
      switch during read/write, corrupt v1/legacy record, concurrent edit and explicit
      repair preserving original damaged bytes.
- [x] PCM split frames/chunks, NaN/overflow/partial sample, all-silent/audible,
      minimum quiet-run/padding boundaries, maximum channels/rate/duration/ranges,
      cancellation and result tied to another source/execution identity.
- [x] Analysis before/after device/owner/media change, helper/decoder death,
      unknown launch/shutdown and cleanup contention. Hold exact source/tree pin until
      confirmed exit; no false recovered map from a stale private result.
- [x] Cache/recipe identity before/after every listening command, original-time
      bookmarks through trim/source switches and silence near retained-cut boundaries.

Extend listening/bookmark/silence-child/owned-media-operation/Library-source
fixtures and headless controls. Synthetic PCM and fake clocks establish domain
behavior only; native decoder, seek precision and audible quality are separate.

### Deferred Windows evidence and deliverables

- [ ] Listen to quiet parts, short speech edges, AB repeats and original/voice
      switches at several rates on both full/trim output, including all-silent media.
- [ ] Real background/lock/sleep/resume timer expiry, audio-device change, decoder
      cancellation and relaunched bookmarks with account changes and offline media.
- [x] Deliver interaction-priority/time-model tables, preference/version examples,
      detector/ownership bounds and portable fault matrix in the whole-task ledger.
- [ ] Add actual W34 listening observations to those source tables.

The [HTML media standard](https://html.spec.whatwg.org/multipage/media.html)
defines asynchronous seeking/playback; matching real media events must be fenced
before repeat accounting. The timer and logical coordinate rules here are
MusicMute policy based on the current Mac implementation.

## Missing comparison map and timer policy closure

- [x] Keep valid trimmed voice standalone playback when comparison map is missing.
      AB/bookmarks on that voice use explicit artifact/output coordinates; store
      the basis with media identity and never reinterpret them as original time.
      Disable unavailable source conversions while retaining standalone controls.
- [x] Preserve Mac timer cancellation when a different queued track starts; a
      timer spanning new tracks is a separate future product change, not accepted
      unchanged parity. Test same-track restart/variant versus different-track Play.
- [x] Test null map, output marker restore, map becoming available, trimmed seek/
      silence/AB boundaries and timer expiry versus queue advancement without
      fabricated timeline or duplicate listening counts.

## Completion record

- Implementation files and review: `main/player/listening.ts`, bookmark/silence modules, fixed Prepare CPU media operation, renderer controls and current main composition.
- Commands/results and evidence: [W19 checkpoint](../evidence/W19-listening-core.md) shares the recorded 55 tests/10 files, TypeScript, scoped lint and source bundles with W18; this is historical portable evidence.
- Historical narrow revalidation: the 2026-10-09 20:15 W19 checkpoint records **77 tests/9 files**, the actual Core/React binding fixtures, owned-file lint/format and source build. Its latest full TypeScript run encountered only the concurrent browser diagnostic response-union integration errors; no listening/player type error was reported. Re-run global checks after that separately owned integration settles.
- Unrun native/toolchain checks: actual Windows FFmpeg/Job execution, codec/seek/listening quality, DPAPI/ACLs, timer behavior under background/lock/sleep.
- Current source return: the whole W19 ledger traces every source/code requirement through actual Main/Library/player/history/Storage and meaningful portable fixtures. Native audible/codec/DPAPI/ACL/Job/OS timing acceptance remains W34; W22/W30 audits continue separately.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Bookmark capacity and atomic persistence return — 2026-10-10

- [x] Preserve 100 bookmarks/title80 UTF-16 units including Arabic without raising
      the native 16 KiB/key cap. Use the existing main/AdvancedListening store,
      at-most64 KiB logical JSON, two fixed bounded chunk generations and an atomic
      hash/length/UUID-bound head; retain legacy records until an explicit edit.
- [x] Serialize real reads/writes/quarantine under the fixed SID metadata mutex;
      require observed-head/chunk CAS, captured installation identity and exact
      raw-byte quarantine before corrupt repair. Failures/unknown ACK cannot
      silently reset bookmarks or overwrite a newer concurrent edit.
- [x] Run 23 bookmark fixtures and 104/9 broader listening/player tests, whole tsc,
      owned lint/format, source build and 2 boundaries. See [current evidence](../evidence/W19-listening-core.md#bookmark-dpapi-capacity-closure--2026-10-10-003438-cairo).
- [ ] W34 real DPAPI/ACL/quota/atomic replacement, crash between chunks/head,
      logout/relaunch and competing-process Unicode bookmark recovery. No Windows
      machine was connected and no native acceptance result is claimed.

This closes the concrete single-record capacity source defect. Broader W19
source/timeline/UI evidence and unrun listening acceptance remain separately
listed above; no global task/progress row is inferred from this narrow change.

## Whole-task source return — 2026-10-10

Each checked source/code requirement above maps to its actual production entry,
resource/owner authority, implementation, named portable fixture and explicit
W34 gate in the [whole-task ledger](../evidence/W19-2026-10-10-closure.md). This
return includes actual Main and sandboxed PlayerPanel/History/Library/offline
analysis composition; it is not inferred from the bookmark104/9 count alone.

The source fixes fence time/seeked/ended callbacks by current seek revision after
awaited accounting and reject stale seek ACKs before logical effects. Explicit
silence-disable clears an old safe error only after a successful current-scope
preference save. Meaningful fixtures reproduced those defects before the fixes.
The current 115/9 tests (rerun at 01:55:36 on 2026-10-10) also cover PCM/threshold/stereo limits, mapped cuts/rate,
max100/title80 bookmarks, scope/generation, actual repeated seek accounting and
retained owned analysis cleanup. Deferred Windows observations remain unchecked.

The final additions prove disposed controllers ignore resume/media callbacks,
and an actual missing comparison map can later become a verified map, restoring
output bookmarks with a new basis while preserving only compatible preferences.
