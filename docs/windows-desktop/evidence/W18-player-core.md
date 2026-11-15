# W18 player source checkpoint — 2026-10-09

Historical foundation checkpoint. Its main-composition-pending paragraph is
superseded for the bindings listed in the [current journey audit](W13-W16-W18-source-journey-audit-2026-10-09.md),
including immediate pending presentation, exact queue edits and duplicate Next
guard. Original command counts and native acceptance limits remain preserved.

Status: in-progress. This checkpoint proves portable code behavior, not Windows playback or a complete release.

Implemented source:

- Typed playback commands and generation-fenced main controller; immediate preparing state, pause/play/stop, logical seek, rates, volume/mute restoration, source comparison and visible queue/repeat/shuffle behavior.
- Verified original/output timeline mapping from retained 44.1 kHz sample ranges; missing/corrupt trimmed mappings fail explicitly. Original playback retains its own verified timeline.
- Bounded loopback media server with short-lived random capabilities, exact allowed origins, HEAD/range requests, file-owner rechecks, streaming/backpressure and shared teardown promises.
- Library source adapter pins the exact artifact before resolving/hashing/opening its descriptor. Pin receipts must match artifact ID/path/checksum; a changed file/owner cannot acquire a media grant. Analysis cancellation keeps the descriptor and pin until its owned cleanup completes.
- React audio adapter and persistent player component, with generation-tagged media events, mapped source seeks, smooth volume and percentage display. Controls and media events use the narrow typed preload bridge. Sleep/AB/bookmark/quiet-part controls live in W19.
- W17 accounting counts only actual playback starts. AB replay additionally requires the matching actual seek completion; duplicate ended/seeked events cannot add starts.

Validation actually run on the Mac:

- `cd windows-desktop && npm test -- tests/listening.test.ts tests/playback.test.ts tests/playback-media.test.ts tests/player-view.test.tsx tests/personal-view.test.tsx tests/desktop-personal.test.ts tests/silence-child.test.ts tests/bookmark-store.test.ts tests/owned-media-operation.test.ts tests/library-playback-sources.test.ts`: **55 tests passed across 10 files**.
- `npm run typecheck`: passed at this checkpoint.
- Scoped `npm exec oxlint -- --deny-warnings` across the player/listening source, typed bridge, personal UI and owned-media tests: zero warnings/errors (27 files).
- `npm run build`: passed; all existing agent bundles, main/preload, renderer and shared companion built.

These checks use headless DOM, trusted-port fixtures and temporary local HTTP/file fixtures. No Electron/browser UI or Windows device was launched.

Remaining source integration: instantiate Library/player in the trusted main composition, connect visible Library order and removal/account transitions, attach durable history, render real metadata, and complete expiry/device-loss handling and storage/update coordination. The public bridge currently rejects playback commands while no player authority is initialized. W18 is not code-complete yet.

Native compilation, real codecs/audio devices, seek accuracy, long/background playback, sleep/resume and actual GPU/Chrome integration remain unchecked in W34.
