# W18 — Implement core audio playback and queue parity

- Status: code-complete — every required source/code action is mapped and portably verified; Windows/native/live acceptance remains pending in W34.
- Code dependencies: [W12](W12-local-files-and-youtube-processing.md), [W16](W16-complete-library-and-metadata.md), [W17](W17-listening-history-and-counts.md).
- Accepted scope points: P14, P15.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [player source checkpoint](../evidence/W18-player-core.md), [current journey/queue audit](../evidence/W13-W16-W18-source-journey-audit-2026-10-09.md), [fresh pending playback](../evidence/W12-pending-playback-and-cancellation-2026-10-09.md).

Handoff boundary: checked rows preserve earlier source evidence. Execute source
work only when implementation is explicitly authorized. Windows machine checks
remain separate and do not block code-only development on the Mac.

Checklist reconciliation: every source/code row below maps to W18 P01–P14/Q1–Q6 in the [exhaustive requirement matrix](../evidence/W13-W16-W18-requirement-closure-2026-10-09.md). Native/live observations are separate unchecked W34 cases. Historical subset counts remain dated evidence.

## Existing behavior and design consequence

AVPlayer behavior must be ported to the Windows/Electron playback stack. Codec support, loopback grants and original/voice timeline alignment require actual Windows acceptance later.

## Read before editing

- [chrome-extension/macos/DesktopWorkspace.swift](../../../chrome-extension/macos/DesktopWorkspace.swift)
- [chrome-extension/macos/DesktopMediaViews.swift](../../../chrome-extension/macos/DesktopMediaViews.swift)
- [chrome-extension/src/companion/original-playback.ts](../../../chrome-extension/src/companion/original-playback.ts)
- [chrome-extension/src/companion/media-server.ts](../../../chrome-extension/src/companion/media-server.ts)
- [chrome-extension/src/companion/audio-integrity.ts](../../../chrome-extension/src/companion/audio-integrity.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Implement portable controller/timeline/media-grant/Library-descriptor foundations and the headless React audio/control adapter; see checkpoint evidence for its exact scope.
- [x] Complete trusted main/Library/history composition and actual application state before closing the product items below.

- [x] Implement play/pause/stop, seek, playback rate, smooth volume with percentage, mute/previous-volume restore and clear preparing/buffering/error states.
- [x] Implement original/voice comparison with timeline-preserving source switches, output verification and generation fences. Keep immediate preparing-player presentation during imports.
- [x] Implement repeat/shuffle and Up Next using the Library's visible order; maintain deterministic queue behavior on filters, item removal, repeat completion and unavailable files.
- [x] Serve local media through the existing bounded media architecture with scoped expiring capabilities, range support and authorized origins; expose neither arbitrary local files nor permanent private URLs.
- [x] Choose and validate the normalized AAC original/MP3 voice and retained original MIME/source contracts, retaining model fidelity and sync declarations; record each candidate codec in the source matrix. Actual pinned Electron/Windows decoder compatibility and listening stay unchecked in W34.
- [x] Implement safe media-error, sleep/resume deadline, expired-grant, cleanup and quit transitions; pin active files until consumer teardown. Actual audio-device loss and Windows lock/sleep/resume observations remain unchecked in W34.
- [x] Connect player events to W17 accounting without counting source switches, seek or buffering as new plays.
- [x] Ignore a duplicate Next during source preparation without consuming a second occurrence, aborting the first load or adding a play. Preserve the first Next from prepared/playing/paused and existing natural-end/repeat/sleep semantics.

## Code validation checklist

- [x] Run the source checkpoint's deterministic player, capability, pin/cancellation, listening and headless UI fixtures, TypeScript, scoped lint and source build.

- [x] Test player and queue state machines with deterministic media adapters, range requests, capability expiry, owner changes and late media events.
- [x] Verify original/voice timeline mapping, volume restoration, shuffle/repeat transitions, output pinning and visible-order queue behavior.
- [x] Run headless UI tests for controls and loading/error states; no Electron/browser UI launch in Phase A.

## Windows acceptance — deferred until W34

- [ ] Test real codecs/audio devices, seek/rate/volume/mute, original/voice synchronization and listening quality on Windows.
- [ ] Verify long playback, background operation, sleep/resume and range streaming without gaps, stale grants or released-in-use files.

## Agent execution contract — planning review 2026-10-09

Use the current main `PlaybackController`, `LibraryPlaybackSources`,
`PlaybackTimeline`, scoped media server and renderer audio adapter. Main now
contains Library/history/player composition; the older evidence note describing
that composition as absent is historical. Revalidate complete journeys before
closing the remaining product rows.

| Boundary    | Input/output and invariant                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection   | Track ID + current visible Library order + exact account scope; immediate preparing state precedes file/grant work.                                       |
| Source      | Main-only trusted descriptor identity, MIME/bytes/SHA, actual source duration, original logical duration and optional retained sample ranges.             |
| Pin         | Exact artifact ID/path/SHA receipt before resolve/hash/open, actual consuming process birth, retained until descriptor/stream/analysis teardown.          |
| Media grant | Short-lived unpredictable loopback capability for the exact descriptor and allowed origin; no arbitrary path, permanent URL or account token in renderer. |
| Events      | Generation/revision-tagged media events, actual playback/seek confirmation and fenced source switches; late events cannot alter a newer track.            |
| Queue/count | Exact visible order/repeat/shuffle semantics and W17 logical playback accounting; seeks/source switches/buffering do not create extra plays.              |

### Implementation order and integration boundaries

1. [x] Review main/preload/renderer composition against Library provider and
       W17 history. Keep renderer commands narrow and validate every payload/event;
       renderer HTML/audio state does not authorize private media access.
2. [x] Verify play/pause/stop, preparing/buffering/error, seek/rate/volume/mute
       and previous-volume restoration. Await/handle the real asynchronous play
       outcome; failed playback cannot be counted or shown as playing.
3. [x] Close comparison across untrimmed and trimmed outputs. Logical time uses
       original 44,100-Hz retained sample coordinates. Preserve position across source
       changes; reject comparison with missing/corrupt maps explicitly while
       retaining valid standalone voice playback. Never scale times by
       output/original duration. Check encoded source duration against the proof.
4. [x] Review queue snapshot, active-item filtering/removal and repeat/shuffle
       transitions. Define whether an already playing filtered item finishes, and
       the exact next selection; no accidental resurrection or duplicate advancement.
5. [x] Close exact grant and range semantics: HEAD/full GET/valid single range,
       suffix/open-ended range, invalid/unsatisfiable range and capability expiry.
       Bound streams/backpressure, reject unapproved origins, and recheck account
       authority for account-owned media while guest playback remains usable.
6. [x] Close interruption/teardown: new selection, stopped player, grant expiry,
       descriptor error, audio-device loss, sleep/resume and quit. Stop/revoke the
       stream/analysis, close descriptors, then release pins; W22 cleanup may race
       only after ownership ends. Do not treat a paused element as released ownership.
7. [x] Reconcile real encoding choices with the pinned Electron/Windows decoder
       and source pipeline. Existing normalized AAC original/MP3 vocals are candidate
       source contracts, not universal codec support. List actual formats needing W34.
8. [x] Integrate W19 timer/AB/silence priority and W17 counting against actual
       events. Repeat accounting requires the matching real seek confirmation;
       duplicate ended/seeked events do not increment history.

### Explicit queue actions — P14 main/preload/UI closure

Trace [P14 acceptance](../FEATURE-ACCEPTANCE.md#p14--player-and-queue), Swift
Library/queue actions, `shared/playback-contracts.ts`, main PlaybackController,
preload and renderer `library-view.tsx`/`player-view.tsx`. The current validated
`QUEUE` command is a starting point, not evidence that each user action is wired.
Reuse that typed path where it can safely express the action; avoid general
renderer mutation/filesystem authority. Maintain exact track IDs, current scope
and queue revision/occurrence identity so delayed clicks cannot affect another
entry. Preserve explicit duplicate occurrences if the Mac queue permits them.

- [x] **Play next:** Library action inserts the selected authorized track as the
      first pending entry; current playback/pin remains active. Bind the UI action
      through narrow preload/main validation and publish the authoritative Up Next.
- [x] **Add to queue:** append the selected authorized track to the pending
      queue, preserving current playback and explicit order; show friendly title/
      artwork and give accessible keyboard/feedback behavior.
- [x] **Play queued entry:** remove exactly the selected occurrence and load/
      play it through verified media preparation; preserve the remaining order.
      No duplicate history start until actual playback confirms.
- [x] **Remove queued entry:** remove only that occurrence; removing a pending
      item must not stop the current track or release its media pin. Reject stale
      occurrence/index/revision and unauthorized account items.
- [x] **Move up:** swap the selected pending occurrence with its predecessor.
      Disable/refuse the first entry boundary, preserve duplicates/remaining order
      and keep already playing audio unchanged.
- [x] **Clear queue:** empty pending entries through the same validated bridge;
      current playback, volume, listening state and source ownership remain intact.
      Render the empty Up Next state from the main snapshot.
- [x] Review repeat/shuffle/visible-order fallback after each explicit mutation,
      account switch and unavailable item. UI must wait for authoritative snapshots
      rather than silently showing a queue order main rejected.

Required code-only fixtures must test **actual main/preload/renderer bindings**
alongside pure controller transitions:

- [x] Run the source-built restricted preload through the production Main ingress
      and actual DesktopApp DOM/snapshot subscription with injected trusted service
      I/O. Cover input/navigation, origin/subframe/schema denial and sanitized
      errors. This generic transport proof does not replace the named P14 action
      cases below; see the current source journey audit.

- [x] Library Play next and Add actions produce validated commands and authoritative
      queue snapshots through DesktopApp → built preload → production Main ingress
      → real PlaybackController. The composed fixture uses guest IDs; duplicate/
      account-ID edge behavior is additionally covered by controller/view fixtures.
- [x] Up Next Play consumes the selected occurrence through that same composed
      bridge and opens the selected injected media source. Separate deferred-open,
      repeated-occurrence and late-event controller fixtures protect once-only
      starts/counts; this is not actual Windows media verification.
- [x] Remove, Move up and Clear produce the exact pending order through the composed
      bridge; a stale prior revision/occurrence fails while current URL/generation
      stays unchanged. First-entry/empty/repeated-occurrence and accessible labels
      have separate controller/DOM fixtures; actual keyboard/device proof remains
      deferred.
- [x] Sign-out/account change during a queued action, removed/missing track,
      malformed or oversized queue and rejected bridge reply fail safely; no prior
      account media grant or optimistic queue resurrection.

Extend playback controller/contracts and headless player/Library view tests.
Code fixtures must cover each named action; testing only direct `QUEUE` parser
acceptance or the pure state model does not close P14 UI wiring.

### Code-only fixture matrix

- [x] Prepared/playing/paused/buffering/error transitions; rejected play promise;
      preparing cancelled by newer selection; source/grant late completion; old
      generation media events and stale seek revisions.
- [x] Untrimmed identity and trimmed ranges with cuts at beginning/middle/end,
      logical point inside a removed interval, exact range boundaries, malformed map,
      missing nullable backend map and duration mismatch. Original remains separately
      playable where authorized; trimmed comparison must not guess.
- [x] Visible order changed by search/sort/filter/favorite/remove, active item
      deletion, missing next file, repeat track/queue/off and deterministic shuffle;
      one transition per actual completion and no duplicated W17 count.
- [x] Volume percentage, previous nonzero value, repeated mute, out-of-range
      rate/seek/NaN payload and renderer command validation.
- [x] Loopback origin, HEAD, complete/ranged/suffix requests, invalid bounds,
      expired capability, account change, stopped stream, slow reader and descriptor
      replaced after pin. No private path/grant in public metadata or diagnostics.
- [x] Active original/voice/silence-analysis pin during W22 cleanup/export;
      cancellation keeps pin until actual owned analysis cleanup. A→B→A artifact
      remap cannot authorize the old descriptor through a new track-level pin.

Extend playback/media/timeline/Library-source/history fixtures and headless
player-view tests. Use deterministic adapters and local temporary HTTP/files,
not an Electron/browser UI launch or a fabricated codec/GPU success.

### Delivered source artifacts

- [x] Deliver player state/queue transitions, retained-sample timeline example,
      grant/pin lifecycle and candidate codec matrix in the exhaustive requirement
      matrix. No actual codec/listening observation is substituted for a fixture.

### Deferred listening/native evidence

- [ ] Real Windows codecs/devices, pause/play/seek/rate/volume/mute and exact
      original/voice positions for both desktop recipes; independently listen for
      quality, cuts, gaps and drift.
- [ ] Long/background playback, device unplug/change, lock/sleep/resume, grant
      expiry and quit/relaunch while Chrome/sync/cleanup are active.
- [ ] Record actual codec-matrix and W34 listening results on the connected Windows target.

[RFC 9110 range semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-14)
and [HTML playback/seeking events](https://html.spec.whatwg.org/multipage/media.html)
define transport/event behavior. MusicMute's exact owner/timeline/pin rules add
application authorization; those standards do not establish Windows codec quality.

## Exact Mac transport and standalone voice parity

- [x] Restart is seek-to-zero without new play count. Manual Next and natural end
      both retain current Mac repeat-mode behavior; Next retains original variant
      where available, while selecting a queued occurrence defaults to voice.
- [x] Preserve paused state during a source switch. Test repeat one/all/off,
      shuffled/manual/natural transitions and queued occurrence selection separately.
- [x] Split standalone trimmed-voice playback from comparison-map admission.
      Missing/null map blocks conversion/switching, not valid voice playback,
      seeking/export/share. Never guess proportional original timing.
- [x] Bind standalone markers to that voice artifact/output timeline under W19;
      original-coordinate actions cannot pretend to have conversion evidence.

Source binding/portable verification checkpoint: [main/player/browser evidence](../evidence/W04-W18-W27-production-bindings.md). Native and remaining feature gates stay open.

## Completion record

- Implementation files and review: `main/player/**`, shared playback/media-range contracts, renderer audio/player adapter and main Library/history composition. Existing main composition was inspected during this planning review.
- Commands/results and evidence: earlier [W18 checkpoint](../evidence/W18-player-core.md) records 55 tests/10 files, TypeScript, scoped lint and source bundles; do not treat that historical subset as a full current native pass.
- Unrun native/toolchain checks: Windows audio devices/codecs, actual timeline/listening quality, background/sleep behavior and private native file/ACL/range lifetime.
- Remaining limitations and next task: retain actual device/codec/grant-expiry/sleep/pin lifetime checks, then named-machine W34 listening evidence. The extended queued-account bridge edge now supplies real playback revocation under an injected owner event; no actual AccountController, Electron or Windows device ran in that bridge. All required source/code rows map to the exhaustive requirement matrix.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

Source continuation: queue edits now use a current playback generation and monotonically increasing queue revision, exact occurrence/index and current Library scope admission. Main/preload/UI expose Play next, append, selected Play, remove, move up/down and clear; renderer whole-queue replacement is rejected. Native acceptance remains open. See [current integration evidence](../evidence/W16-W18-W29-final-integration.md).

The [current audit](../evidence/W13-W16-W18-source-journey-audit-2026-10-09.md)
records 226 code tests across 23 relevant suites. New deferred-source fixtures
verify duplicate Next from prepared/playing/paused, controlled shuffle/repeat
queue, unchanged pending generation/order and accounting only after actual
playing. A frozen accepted queue is not rebuilt by later search/filter/hide;
that matches the Mac source queue model. Current parser/core/headless checks and
production main/preload review do not claim actual Windows command transport,
codec quality, device loss or listening success. Keep those native rows open.

The coordinating agent's **22:19:16** stable full Desktop checkpoint also passed
**1,424 tests / 174 files**, whole TypeScript/lint/format/build and two
package-boundary tests. This includes the frozen duplicate-Next regression and
current production bindings; it does not close the distinct main/preload
named P14 action transport matrix or any actual Windows/device acceptance row.

Subsequent transport proof: `desktop-ipc-transport.test.tsx` first passed its three
generic cases in the **22:38:45**, **142-test / 11-file** regression. Its additional
six-action P14 case uses the actual DesktopApp, source-built restricted preload,
production Main ingress and real PlaybackController, with injected source/media
I/O. The extended four bridge cases and seven composed Cloud cases passed together
at **22:43:30**, **11 tests / 2 files**. There was no Electron launch. The separate
bridge later gained a held queued-account/sign-out case (owner event injected,
real PlaybackController revocation), which passed 4/1 at 22:45:48. Neither bridge
composition constitutes Windows/device acceptance.
