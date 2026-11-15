# W19 advanced listening source checkpoint — 2026-10-09

Status: in-progress. This file preserves the initial portable source checkpoint and the later composed-source revalidation below. Windows acceptance remains open.

The macOS source was traced before porting. Its detector reads 1024-frame PCM blocks, considers RMS below `0.00316227766` quiet, keeps runs at least 0.4 seconds, pads both edges by 0.06 seconds, and bounds analysis to two channels, 8–192 kHz, two hours and 10,000 ranges. The Windows streaming detector uses those same thresholds and bounded chunk memory.

Implemented source:

- Sleep deadline/remaining/cancel/expiry and Electron resume hook. Remaining time is the minimum of prior remaining time, wall deadline and monotonic elapsed duration. System sleep/forward clock changes expire the deadline; backward clock changes cannot extend it. The current Mac-derived policy cancels when a different track starts and retains the timer through same-track restart/comparison; app quit cancels it.
- Original-time AB markers, minimum 0.1-second range, marker clear, duplicate-boundary fencing and comparison consistency. Sleep expiry has priority over AB, then voice-only silence skipping. AB counting waits for the actual matching generation/revision/target seek completion while playing.
- Up to 100 owner/device-scoped logical bookmarks, duplicate-position tolerance 0.5 seconds, rename/remove/navigation and serialized writes. Account generations fence delayed reads/writes. Source switching keeps the original-time coordinates.
- DPAPI current-user bookmark storage uses hashed SID/installation/owner/track keys and a 16 KiB bound. A damaged record stays visible as an error; the next explicit edit retains the exact damaged bytes before repair. The v1 reader accepts the earlier bookmark-only form; new records also retain the silence preference.
- Bounded/cancellable PCM analysis, strict configuration/probe/result validators and the fixed `silence_analyze` CPU media operation inside the verified Prepare entry. It never loads a model or certifies GPU readiness. Current input/output use the shared admitted private `prepare/work/<request UUID>` workspace; the earlier isolated listening workspace was superseded by W22 writer/exit integration.
- Real owned-native-Job runner source: signed inventory verification, Prepare mutex, exact birth/nonce exit matching, whole-tree teardown, and conservative handling of an unknown launch/shutdown outcome. Such outcomes retain private scratch for later reconciliation rather than deleting a file a decoder could still use.
- Verified Library descriptor staging and checksums; voice analysis holds its file pin. Silence skipping is a playback seek preference and does not rewrite cached media or change the Chrome processing recipe.
- Headless React controls for timers, AB, bookmark editing and silence preparation/error states.

Code checks actually run: the combined W18/W19/personal suite recorded in [W18 evidence](W18-player-core.md) passed **55 tests/10 files**; desktop TypeScript, scoped lint (zero warnings/errors) and source bundles passed. Cases include clock/sleep jumps, AB confirmation, duplicate callbacks, source switches, account changes, corrupt preferences, concurrent writes, all-silent/audible PCM, split chunks, malformed/cancelled input, exact source/execution binding and cleanup ownership.

Remaining source work: trusted main/Library/player/history composition, actual offline acquisition integration, final persisted-preference/UI checks and storage/update/quit coordination. The native helper and Windows FFmpeg branch have not been compiled or executed on Windows. Real listening quality, decoder behavior, seek precision and lock/background/sleep scenarios stay unchecked in W34.

## Composed-source race and ownership revalidation — 2026-10-09 20:15

The historical remaining-source paragraph above describes the initial checkpoint.
Current main composition now connects Library/player/history and the admitted
owned silence runner. This revalidation closes concrete domain races without
claiming actual Electron, Windows decoder or audible device acceptance.

Changes reviewed:

- A bookmark/AB/silence command captures its accepted logical position and
  media/owner generation before awaiting preference IO. A later track or owner
  cannot receive that command; commands against the previous coordinate context
  during replacement preparation are ignored.
- The requested track exists before source Ready. A sleep selection during
  preparation therefore remains attached to that track; same-track restart and
  comparison retain it, while a different track cancels it.
- Requested media generation changes abort and retire the old analysis before
  replacement Ready. A cancelled decoder result or error cannot set the newer
  source's skip/error state.
- Media handlers capture the actual source/timeline/generation and recheck it
  after asynchronous accounting and listening operations. Late old-track `time`
  and repeat `seeked` events cannot seek or account against a new AB loop, and an
  old ended handler cannot advance the newer queue after an awaited boundary.
- Guest-source bookmarks use the stable local preference owner through A→B
  account changes. Analysis continues to use exact Library pins/private staged
  voice bytes; the retained-workspace tests require positive exact owned exit
  proof before releasing unsafe scratch reservations.

Implementation files: `windows-desktop/src/main/player/listening.ts` and the
narrow `publish`/media-event paths in `main/player/controller.ts`. Regression
files: `tests/listening.test.ts`, `tests/playback.test.ts` and the new
`tests/listening-player-integration.test.tsx`. The React fixture uses the actual
PlayerPanel and controller with injected HTML media methods and fake time; it is
a code binding check, not a native audio/UI acceptance test.

Checks actually run for this slice:

- `npx vitest run tests/listening.test.ts tests/playback.test.ts tests/history-playback.test.ts tests/bookmark-store.test.ts tests/listening-player-integration.test.tsx tests/library-playback-sources.test.ts tests/silence-runner-storage.test.ts tests/silence-child.test.ts tests/owned-media-operation.test.ts`: **77 tests/9 files passed**, start 20:15:05.
- Scoped `oxlint --deny-warnings` and Prettier checks on both source modules and
  the three changed/new test files: zero errors/warnings and formatting passed.
- `npm run build`: source bundles passed.
- The TypeScript run before the separately owned browser diagnostic reply union
  changed passed. The later full `npm run typecheck` reported only missing
  `state` narrowing in `browser/account-bridge.ts` and its tests, where the new
  successful diagnostics reply is also valid. No W19-owned type error was
  reported; global revalidation must follow that integration's correction.

Later revalidation note: the full desktop TypeScript checkpoint at 20:29 passed
after the browser diagnostic reply integration settled. W19 source was unchanged.

Still deferred: actual Win32 native/Job/DPAPI/ACL behavior, Windows FFmpeg codec
execution, seek precision and audible trim/silence/AB/bookmark behavior, real
background/lock/sleep timer behavior, and W34 machine acceptance. These tests did
not download models/runtimes or run GPU inference, registration or live actions.

## Bookmark DPAPI capacity closure — 2026-10-10 00:34:38 Cairo

Production `main.ts` constructs `WindowsBookmarkStore(context)` for the existing
AdvancedListening/PlaybackController path. The accepted record of 100 bookmarks,
each with an 80-unit Arabic title, is about 23 KiB; the previous single 16 KiB vault
write could not preserve it. The native 16 KiB per-key limit is unchanged.

[WindowsBookmarkStore](../../../windows-desktop/src/main/player/bookmark-store.ts)
now commits a logical record of at most65,536 UTF-8 bytes with an exact version 2
`bookmark-parts` head at the existing `bm_<58hex>` key. The head contains a fresh
UUID generation, slot 0/1, total bytes/SHA and 1–4 exact chunk bytes/SHA bindings.
Chunks at fixed `b0_/b1_<58hex>_<0..3>` keys each remain at most 16,384 bytes.
Only the inactive slot is written/deleted before the one atomic native head
write; the previous active slot remains readable on pre-commit failure. Two
slots bound live/old data to 8 keys, with stale inactive trailing chunks pruned.
Neither owner UID nor track text appears in the native key. Domain bookmark v1,
100/title 80 bounds and coordinate/account partitions remain unchanged.

All reads, mutations and quarantine run under the actual fixed current-SID
`metadata` mutex, with a per-helper store queue, bounded 5-second contention wait,
exact lease release/retry and captured SID/installation rechecks. Native vault
operations retain their existing current-user DPAPI/private ACL/atomic replacement
boundary. Store writes compare the last observed exact head and selected chunks;
new stores may initialize only absent heads. Fresh manifest UUIDs reject same-body
ABA after two slot flips. A lost commit ACK reports unavailable and requires a
fresh read before a later edit; it does not blindly overwrite/repeat a transaction.

Existing single-record v1 bytes remain readable without migration writes; only
an explicit edit publishes the multipart form. Duplicate decoded JSON keys,
invalid UTF-8, malformed bounds/manifest, missing chunks and chunk/full SHA
mismatch cannot produce an empty-success preference state. The existing explicit
repair first quarantines exact damaged raw head and captured selected chunk bytes
at bounded `bmbad_`/`bq_` keys, preserving absent-chunk evidence. Malformed heads
are retained verbatim without interpreting arbitrary chunk paths. Changed or
incompletely captured evidence, or archive ACK failure, denies repair. One most
recent quarantine is retained; no user data or production vault was touched here.

Executed checks:

- Bookmark fixtures: **23 passed**, using a fake native vault that enforces the
  actual 16 KiB/key and 64-character key limits and an ownership-aware shared mutex.
  A real AdvancedListening restore confirms all 100 Arabic bookmarks survive.
- `vitest run` for bookmark-store/listening/listening-player-integration/playback/
  history-playback/silence-runner-storage/silence-child/owned-media-operation/
  library-playback-sources: **104 passed/9 files at 00:34:38**.
- Whole `npm run typecheck`; owned oxlint (zero warnings/errors) and Prettier:
  **passed**. Initial local TS narrowing and constant-loop lint failures were
  fixed and rerun, not renamed successful runs.
- `npm run build`, `npm run test:package-fixtures`, source-digest readback:
  **passed**, 2 boundaries; unchanged native digest `3bf83a63a62a35ba8e5c8be4b1807c25a66fa36c8399b674d35815810606a1ba`.

Fault fixtures cover part/delete/head failure before commit, commit ACK loss,
missing/corrupt/invalid-UTF8 chunks, duplicate/malformed manifests, whole SHA
mismatch, CAS/ABA, competing read/write, legacy bytes, archive failure/changed
source, interrupted capture, host identity change, bounded slot pruning and exact
failed lease release. Root's 1,764/205 checkpoint at 00:21 predates this change.

- [ ] W34 actual standard-user DPAPI/ACL/key-limit roundtrip with100 English/
      Arabic/Unicode titles, logout/relaunch/account partitions and legacy records.
- [ ] W34 crash/ACK-loss between each real chunk/delete/head/metadata-release,
      simultaneous processes/logons and encrypted corrupt/missing part recovery.
      Assert the committed generation remains atomic and uncertain data is retained.

The [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were re-read 2026-10-10: portable security, JSON/Unicode, compatibility and bounded
safe-error rules apply. This is a private persistence schema, so REST URL/HTTP/
OpenAPI registry rules do not replace the existing domain/DPAPI architecture.
No Native compiler, Windows DPAPI, installed application, UI/audio or live check ran.
