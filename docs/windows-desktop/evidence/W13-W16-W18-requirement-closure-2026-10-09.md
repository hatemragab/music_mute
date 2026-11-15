# W13/W16/W18 exhaustive source requirement closure

Date: 2026-10-09. This maps every implementation/code checklist, numbered execution
step, named action, fixture group, invariant and deliverable in the three task
files. Repeated planning rows share a requirement ID; native/live rows are distinct
and remain unrun. A controller's existence alone is not the portable proof.

## Entry and proof locators

Production locators below are relative to `windows-desktop/src/`:

- Cloud: [main/cloud/controller.ts](../../../windows-desktop/src/main/cloud/controller.ts)
  (`restore/setMode/prepare/confirm/resolveDownload/cancel/shutdown`),
  [cloud/media.ts](../../../windows-desktop/src/main/cloud/media.ts),
  [cloud/transfers.ts](../../../windows-desktop/src/main/cloud/transfers.ts),
  [user-realtime.ts](../../../windows-desktop/src/main/realtime/user-realtime.ts),
  [usage](../../../windows-desktop/src/main/usage/account-usage.ts).
- Library: [controller](../../../windows-desktop/src/main/library/controller.ts),
  [model/store](../../../windows-desktop/src/main/library/model.ts),
  [store](../../../windows-desktop/src/main/library/store.ts),
  [artifacts](../../../windows-desktop/src/main/library/artifacts.ts),
  [provider](../../../windows-desktop/src/main/library/provider.ts),
  [pins](../../../windows-desktop/src/main/library/pins.ts),
  [export](../../../windows-desktop/src/main/library/export.ts),
  [thumbnails](../../../windows-desktop/src/main/library/thumbnails.ts),
  [factory/delete](../../../windows-desktop/src/main/library/factory.ts).
- Player: [controller](../../../windows-desktop/src/main/player/controller.ts),
  [timeline](../../../windows-desktop/src/main/player/timeline.ts),
  [media server](../../../windows-desktop/src/main/player/media-server.ts),
  [Library sources](../../../windows-desktop/src/main/player/library-sources.ts),
  [listening](../../../windows-desktop/src/main/player/listening.ts),
  [renderer player](../../../windows-desktop/src/renderer/player-view.tsx).
- Actual application bindings: [Main](../../../windows-desktop/src/main/main.ts)
  (`CLOUD/LIBRARY/PLAYBACK`, account-scope invalidation, `powerMonitor.resume`,
  completion adoption, native save/share), [preload](../../../windows-desktop/src/preload/index.ts),
  [closed command schemas](../../../windows-desktop/src/shared/contracts.ts),
  [Library UI](../../../windows-desktop/src/renderer/library-view.tsx),
  [Cloud UI](../../../windows-desktop/src/renderer/cloud-view.tsx).

Proof names identify files in `windows-desktop/tests/`; shared proof names prefixed
`extension/` identify `chrome-extension/tests/`. The code below uses real domain
classes, synthetic ports, temporary file descriptors and loopback HTTP. Native
process/ACL/codec observations are injected. DOM is JSDOM; the preload bridge is
source-built in a VM with an injected Electron boundary. Neither launches Electron,
Chrome, Windows, a real codec nor model inference.

Deferred-case keys: **N1** actual Firebase/backend/R2 policy/quota/auth/reconnect;
**N2** installed shared Chrome/native messaging and synchronized audio;
**N3** Windows ACL/reparse/hardlinks/file locks/Job/mutex/Save/WinRT Share/crash;
**N4** real Electron/Windows codecs/devices/listening/background/sleep/RTL/DPI.
Each native key is an unchecked W34 case, never a portable pass.

## W13 requirement matrix

| ID / task requirements                                                               | Production entry and invariant                                                                                                                                                                                                   | Portable proof                                                                                                                                                  | Deferred case |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| C01 — persisted mode, signed-out selection; top I1/foundation1, detailed step1       | `VaultCloudModeStore`, `CloudController.restore/setMode`, Main `CLOUD`, native browser selection. Local and Cloud stay explicit; unavailability does not change preference or bill.                                              | `cloud-controller`, `unconfigured-cloud`, `cloud-view`, `browser-provider-service` saved Cloud/local-miss cases                                                 | N1/N2         |
| C02 — account/email/build/policy/quota; I2, detailed1/2, race matrix                 | `AccountController`, `AccountUsageController.assertCloudSubmission`, `createCloudApi.beforeIntake`; current access rechecked after token awaits, stale quota/policy cannot authorize.                                            | `account-controller`, `usage-controller` arithmetic/zero/stale/reset/min-build matrices; `cloud-controller` delayed token/policy/503                            | N1            |
| C03 — HTTP commands + shared full snapshots; I3, detailed3                           | `UserRealtimeController.cloudLease`, shared `CloudProcessingProvider.wait`; leases release their own subscriptions only. No status GET/refetch loop.                                                                             | `realtime-controller` one socket, gaps/duplicates/old stream/reconnect/lease release; `cloud-composed-io` actual import/job frames and command-only backend I/O | N1/N2         |
| C04 — UI-only link hiding; I4, code3, detailed6/cold2                                | `AccountUsageController` visibility projection, Cloud form and native picker; Chrome controls remain independent. Existing accepted jobs continue.                                                                               | `usage-controller`, `usage-guest-policy`, `cloud-controller` hiding while accepted                                                                              | N1/N2         |
| C05 — Local auto vs deliberate manual Cloud/handoff; I5, detailed6, manual1/2        | `CloudController.browserSettings/assertBrowserAutomatic/acceptBrowserHandoff`, `BrowserAccountAuthority`, `BrowserProviderService`, shared manual START. Handoff prefills; it does not bill.                                     | `cloud-controller`, `browser-account`, `browser-provider-service`; `extension/browser-cloud-provider` and `extension/browser-processing-bridge`                 | N2            |
| C06 — cancel/reconnect/grant expiry/mode changes/503; I6, race matrix                | `CloudController.cancel/accountChanged`, provider command identity and lease close, bounded transfer aborts. Known-job ACK means requested; pre-job import cancellation is unavailable; no non-idempotent POST replay.           | `cloud-controller` known/import cancel, retained mode and 503; `cloud-transfers` expiry/foreign/hash/type/abort; `browser-account` exact replay/body mismatch   | N1/N2/N3      |
| C07 — owned CPU tooling and declarations; foundation2, detailed4                     | `WindowsCloudMedia.prepareFile/download`, fixed `WindowsCloudMediaRunner` and `runOwnedMediaOperation`, `CloudScratchWorkspace`; decode/encode/probe is CPU tooling, never CPU model fallback.                                   | `cloud-media-child`, `cloud-media-runner`, `cloud-media-storage`, `cloud-composed-io` real copied/uploaded/downloaded bytes and injected strict codec reply     | N3/N4         |
| C08 — source/rights/current owner/expiry/single use; detailed2, code1/2              | `prepareFileConfirmation/prepareYouTubeConfirmation/confirm`, validated source ID, private descriptor capability and 5-minute review; no request before deliberate rights confirmation.                                          | `cloud-controller`, `cloud-view`, `cloud-composed-io` exact frozen request and replay refusal                                                                   | N1/N4         |
| C09 — dynamic window file owner, adoption and scratch lifetime; detailed5            | Main dynamic file-owner callback; `FileCapabilities`; current-scope `completedResult` → `LibraryController.adoptCloudResult`; FD remains pinned through immutable copy and close.                                                | `account-lifetime`, `cloud-media-storage`, `cloud-composed-io` borrowed handoff A→B and one-use descriptor                                                      | N3            |
| C10 — file prepared/output path collision closure                                    | `resolveDownload` awaits actual prepared close after verified Ready/upload completion, then rechecks owner/abort before same-request result admission.                                                                           | `cloud-composed-io` URL/file success, cancel/owner change during held close, refused cleanup retaining activity with zero result GET/new workspace              | N3            |
| C11 — UI phases/recovery/EN/AR; detailed7                                            | `CloudPanel`, Main Cloud snapshots, error/policy presentation and explicit review/Back/Library/cancel controls. Mode changes govern new intake.                                                                                  | `cloud-view`, `localization`, `cloud-controller`; composed progress transitions                                                                                 | N4            |
| C12 — cold browser manual Cloud, no model/FFmpeg; cold1/3                            | Sole browser account authority and `WindowsBrowserMedia` deliver verified remote/cached bytes without a local session/model. Native file Cloud separately requires signed CPU tools; normal GUI P05 auto-Prepare is independent. | `browser-account`, `browser-provider-service`, `browser-media`, `unconfigured-cloud`; cold replay/owner/idle cases                                              | N1/N2         |
| C13 — browser source/tab/video/generation/late result and no token exposure; manual3 | Closed browser/account envelopes, actual signed peer/owner fences, source duration/full recipe identity; safe loopback delivery, no backend grants/tokens in Chrome.                                                             | `browser-account` wrong peer/source/replay/late account; shared `extension/browser-processing-bridge`, `extension/browser-cloud-provider`                       | N1/N2         |
| C14 — required composed domain I/O deliverable                                       | Real AccountController → raw account socket → usage/cloud/provider → WindowsCloudMedia → real Library controller/disk/cache/storage; captured A cannot attach to B.                                                              | Seven `cloud-composed-io` cases; [exact evidence](W13-composed-cloud-io-2026-10-09.md)                                                                          | N1/N3/N4      |

Dependency/order text refers to W14/W15 foundations followed by authenticated W13
composition; those foundations are now actual production bindings. Read-before
references and the race matrix are covered by C01–C14; native variants remain N1–N4.
The code-only contract does not require a genuine remote account, quota charge or
real R2 request to claim these portable compositions.

## W16 requirement matrix

| ID / task requirements                                                               | Production entry and invariant                                                                                                                                                                                                               | Portable proof                                                                                                                                                                  | Deferred case |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| L01 — merge and explicit ownership; I1, contract local/account/link, numbered1/2     | `personalLibraryEntry/accountLibraryJob/mergeLibrary`, UID-partitioned `LibraryStore`, captured completion hook. Equal title/checksum alone cannot create an account link; guest survives sign-out.                                          | `library-model`, `library-controller` guest/link/owner atomicity; `library-provider` guest A→B; `outbox-completion` receipts                                                    | N3/N1         |
| L02 — all query/actions and count aliases; I2, numbered4                             | `visibleLibrary`, controller `QUERY/STAR/HIDE/RESTORE/RENAME/DELETE_ACCOUNT`, scoped preferences; History changes are optional independent input.                                                                                            | `library-model`, `library-controller` Most Played live counts/sort/filter/alias/actions; `library-view`, `history-controller`                                                   | N4/N1         |
| L03 — thumbnail all surfaces; I3, numbered7                                          | `publicThumbnailUrl`, `LibraryThumbnailCache`, controller visible hydration (50 rows/3 concurrent/4MiB inline/URL dedup), Library/Now Playing/Up Next `thumbnailDataUrl`; raster magic/dimensions, no HTML/private grants.                   | `library-thumbnails`, `library-artifacts` cache/redirect/limits/recovery, `library-thumbnail-abort`, `library-controller` query epoch; `player-view`/source binding             | N4/N1         |
| L04 — download/original/offline availability; I4, numbered6, direct-original1        | `download` and `LibraryArtifactCache`, `LibraryPlaybackProvider` variant lookup; original is independent. Unavailable voice disables voice intake without blocking verified original.                                                        | `library-controller` output/input grants/eviction; `library-provider` standalone original; `library-view` original-only case                                                    | N1/N3/N4      |
| L05 — export/save/share and Windows names; I4/7, numbered8                           | `exportLibraryTrack` exact pin/descriptor/checksum/bytes/fsync + exclusive `WindowsSaveDestinations`; Main typed exports/share, `WindowsShareController`; no renderer path or overwrite.                                                     | `library-export`, new `library-export-fault-matrix`, `save-destinations`, `share-controller`, `storage-share-workspace`, `library-view` ID actions                              | N3/N4         |
| L06 — distinct destructive/local actions; I4, numbered4/9                            | Hide is preference only; remove-cache deletes authorized unpinned app cache; DELETE_LOCAL tombstone/catalog authority; DELETE_ACCOUNT current server ACK then matching playback retirement.                                                  | `library-controller` action distinctions + positive/error/stale ACK; `library-artifacts` source preservation/unpinned deletion; `storage-local-deletions` crash sides           | N1/N3         |
| L07 — exact visible order and accepted queue; I5/contract visible, numbered4         | Main `LIBRARY_PLAY` captures `controller.visibleOrder`, `playFromLibrary` queues only following IDs. Later filtering/hide does not rebuild an already accepted queue; explicit account deletion/owner invalidation retires only exact items. | `library-controller`, `playback`, `desktop-ipc-transport` named actions and signout; source Main binding                                                                        | N4/N3         |
| L08 — account partition, live pages, reconnect; I6/contract account, numbered3       | `setScope/bind/pages` full snapshot page replacement, dedup merged pages before `saveAccountJobs`; 82 watchers/4096 rows, no status polling.                                                                                                 | `library-controller` A+B replacement/old callbacks/reconnect/malformed; new `library-pagination-bounds` exact caps                                                              | N1/N4         |
| L09 — History damage is secondary, no catalog reset; contract introduction/numbered9 | `refreshLocal` catches optional History failure, preserves media and exposes separate History recovery.                                                                                                                                      | `library-controller` corrupt History usability; `history-store`, `library-view` explicit recovery                                                                               | N3/N4         |
| L10 — immutable account publish and rollback; numbered5                              | `LibraryArtifactCache.publish` hash/birth journal + one cache mutex, verified existing identity reused; failed writer removes only its own partial/new births.                                                                               | `library-artifacts` immutable inode/artifact, active pin + corrupt late publisher, owner loss; `storage-write-journal` rename/commit/replaced birth                             | N3            |
| L11 — only exact ENOENT linked fallback; I9/numbered6                                | Controller/provider select current explicit link and variant SHA+bytes; ACL/integrity errors are never a miss. Restored account-owned source carries current account fence.                                                                  | `library-controller` ENOENT vs EACCES/EPERM/EIO/integrity/bytes/owner tests; `library-provider` linked restore/pin identity                                                     | N1/N3         |
| L12 — trimmed standalone playback/export/share; trim1/3 and direct-original2         | `accountLibraryJob` keeps valid audio with missing/corrupt map; provider requires actual voice duration, timeline disables conversion only; exact export/share need no reuse/account-save receipt.                                           | `library-model`, `library-provider`, `playback` nullable map/voice-output; new trimmed guest/account export; `share-controller` trimmed bytes; `library-view` EN/AR explanation | N3/N4         |
| L13 — full-timeline Save eligibility/error separate; trim2/4                         | `saveLocalToAccount`/Outbox require verified full-timeline reuse; Main Save does not mutate playback/artifacts. No new private trimmed ingest/profile is required by current Mac parity.                                                     | `local-save`, `outbox-controller/media`, new real `PlaybackController` + parsed trimmed pair unsupported-Save case preserving current playback/bytes                            | N1/N3         |
| L14 — exact pin before resolve/hash/open/export; contract pin/playback               | `LibraryPins` actual consuming PID+birth; `LibraryPlaybackSources` and exporter match artifact/path/SHA against pin before FD work. A→B→A or changed path cannot authorize old data.                                                         | `library-provider`, `library-playback-sources`, `library-export` remap and new source replacement/owner-copy faults                                                             | N3            |
| L15 — thumbnail deadline/bad type/size/query; fixture row5                           | Fixed 10-second fetch deadline, abort signal, safe raster fallback and current query/account epoch; no pixel publication on timeout/abort.                                                                                                   | `library-thumbnail-abort`, `library-thumbnails`, `library-artifacts`, controller hydration dedup/query case                                                                     | N1/N4         |
| L16 — interrupted save/share and deletion recovery; fixture row6                     | Exclusive destinations discard only own partial; Share inspected terminal+callback+quiescence, unknown ACK retains durable stage; exact deletion WAL restores uncommitted or removes committed tombstone.                                    | New export ENOSPC/EIO/cancel/owner faults; `share-controller`, `storage-share-workspace`, `storage-local-deletions`, `save-destinations`                                        | N3            |

All six W16 code-fixture groups map to L01/L02/L12; L08/L09; L04/L11;
L10/L14; L03/L15; L05/L06/L16 respectively. Numbered steps 1–9 and every
contract invariant map above. Action/ownership/order/recovery deliverables are
provided below; actual Windows results are deliberately absent.

## W18 requirement matrix

| ID / task requirements                                                                  | Production entry and invariant                                                                                                                                                                                      | Portable proof                                                                                                                                                     | Deferred case |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| P01 — core composition/closed commands; foundation1/2, numbered1                        | Main Library/history/player, production `createDesktopIpcHandler`, source-built frozen preload, `parsePlaybackUiCommand`, actual `DesktopApp`. Untrusted subframes/fields cannot dispatch.                          | `desktop-ipc-transport`, `contracts/security`, `playback` invalid values/whole QUEUE denial                                                                        | N3/N4         |
| P02 — immediate preparing and error/retry/cancel/empty; I1/2, numbered2, fixture1       | Personal pending descriptor before intake and player `load` before FD work; Stop/cancel revokes exact request; errors permit explicit re-selection/keep-offline recovery, no automatic inference or billed retry.   | `preparing-player-view`, `personal-preparation-integration`, `player-view`, `playback` late source/errors/Stop                                                     | N4/N3         |
| P03 — play/pause/stop/seek/rate/volume/mute; I1, numbered2, fixture4                    | `PlaybackController.execute`, renderer `PlaybackAudio` asynchronous play promise/events and smooth volume; finite bounded schema, last audible restore.                                                             | `playback` volume/rate/payload/event cases; `player-view`, `localization`                                                                                          | N4            |
| P04 — comparison/exact sample timeline; I2, numbered3, fixture2                         | `resolvePlaybackTimeline` + `PlaybackTimeline` 44100-Hz intervals; no proportional mapping. Missing map leaves independent original or voice-output timeline; sample/duration proof bounds conversion.              | `playback` cuts/identity/missing map/direct original, `library-model/provider`, `player-view`; private personal timeline tests                                     | N4            |
| P05 — source switches preserve paused/position; exact Mac row2                          | `load(...same=true)` keeps intent/logical position, fresh generation and exact new source; unavailable comparison is explicit.                                                                                      | `playback` paused switch/trim/late events; `listening` marker coordinate cases                                                                                     | N4            |
| P06 — visible queue, repeat/shuffle/unavailable/removal; I3, numbered4, explicit review | `playFromLibrary/next/queue edit`, deterministic random input and frozen following visible order; filters/hide do not rebuild accepted queue, owner revocation prunes account IDs.                                  | `playback`, `library-controller`, `desktop-ipc-transport` authoritative snapshots and stale revision                                                               | N4            |
| P07 — loopback scoped ranges/limits; I4, numbered5, fixture5                            | `ScopedMediaServer` owner/token/origin/Host/MIME/method/query, expiry, max32 grants/max8 readers, bounded 64KiB stream/backpressure; recheck verified file before each range.                                       | `playback-media`, new `playback-range-lifetime-matrix` full/HEAD/suffix/open-ended/invalid ranges, true HTTP Host, eight paused readers/429 and once-only FD close | N3/N4         |
| P08 — exact pin and interruption teardown; I6, numbered6, fixture6                      | `LibraryPlaybackSources` pins before hash/fingerprint/FD, cancels and waits pending analyses/acknowledgements; controller Stop/new load/release, Main quit/account/resume bindings. Paused media retains ownership. | `library-playback-sources`, `playback`, `silence-runner-storage`, media slow-reader revocation, `account-lifetime`                                                 | N3/N4         |
| P09 — codec/source contracts; I5, numbered7                                             | AAC-LC normalized originals / MP3 vocals, actual declared original formats and duration/integrity checks; renderer MIME allowlist is a candidate contract, not Windows decoder certification.                       | `cloud-media-child`, private engine/pipeline declarations, provider/timeline validation; candidate matrix below                                                    | N4            |
| P10 — actual playback accounting; I7, numbered8                                         | W17 captured source owner, real playing/seek confirmation. Buffer/seek/source switches do not add plays; repeat/AB await matching actual seek and playing.                                                          | `playback`, `history-playback`, `history-controller`, `listening-player-integration` delayed accounting/generation cases                                           | N4/N1         |
| P11 — duplicate Next/late events; I8/fixture1                                           | `next` preparing guard, generation/seek revision checks after every await; first Next retains prepared/playing/paused and repeat/shuffle behavior.                                                                  | Deferred-open `playback` table, late time/repeat seek/silence/accounting cases                                                                                     | N4            |
| Q1 — Play next                                                                          | Library button → narrow append-next command → production ingress → controller insert-first pending; current source unchanged.                                                                                       | `desktop-ipc-transport`, `library-view`, `playback`                                                                                                                | N4            |
| Q2 — Add to queue                                                                       | Same validated route appends exact current authorized ID; friendly artwork/title and authoritative snapshot.                                                                                                        | `desktop-ipc-transport`, `player-view`, `playback`                                                                                                                 | N4            |
| Q3 — Play queued occurrence                                                             | Generation+revision+index+ID, remove exactly selected occurrence then actual verified source load; no play count until actual playing.                                                                              | `desktop-ipc-transport`, repeated-occurrence `player-view/playback`                                                                                                | N4            |
| Q4 — Remove occurrence                                                                  | Same exact fence; removing pending entry preserves current source/URL/generation/pin.                                                                                                                               | `desktop-ipc-transport`, `player-view`, `playback` stale duplicate/revision                                                                                        | N4            |
| Q5 — Move up                                                                            | Exact occurrence swap, first-entry disabled/refused, duplicates/order retained; move down is also implemented.                                                                                                      | `desktop-ipc-transport`, `player-view`, `playback`                                                                                                                 | N4            |
| Q6 — Clear                                                                              | Pending queue only, current playback/source/listening/volume unchanged; empty state is authoritative.                                                                                                               | `desktop-ipc-transport`, `player-view`, `playback`                                                                                                                 | N4            |
| P12 — queue owner loss/invalid data/rejected bridge; named fixture4                     | Current admission plus immediate `invalidateOwner`, monotonic occurrence revision; a held account queued command cannot open after revoked authority, guest source survives.                                        | Extended `desktop-ipc-transport` actual bridge/real controller with injected owner event; `playback` removed/invalid/oversize/scope cases                          | N3/N4         |
| P13 — Restart/manual Next/variant parity                                                | Restart is seek, retains paused intent and count; manual/natural Next use repeat rules and retain original when available, queued selection defaults voice.                                                         | `playback` Restart/manual repeat/variant fallback; `player-view`                                                                                                   | N4            |
| P14 — W19 priority and owner/media coordinates                                          | Sleep before AB before silence; resume uses monotonic/wall-clock bound; bookmarks/AB scoped by exact owner/artifact/time coordinate, guest independent of ambient account.                                          | `listening`, `listening-player-integration`, `playback`, `silence-runner-storage`                                                                                  | N4/N3         |

The six W18 general fixture groups map respectively to P02/P05/P11; P04;
P06/P10/Q1–Q6; P03; P07/P12; P08. Numbered steps 1–8 and all boundary invariants
are mapped above. The player bridge injects the owner event and source/codec I/O;
it does not contain a real AccountController. The separate W13 composition does
use the actual AccountController. Main's account-scope wiring is inspected source,
not a launched Electron/DPAPI/Firebase journey; that remains N1/N3/N4.

## Delivered Library action/ownership/recovery table

| Action/example                                         | Authority and effect                                                                                                                                            | Playback/order/rollback rule                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Guest ready pair while A logs out/B logs in            | Windows SID/installation guest catalog; completion retains captured null/account receipt separately                                                             | Guest bytes and playback survive; no automatic B account attach                                                          |
| Local result explicitly linked to A job                | Current A partition plus explicit local ID/job/output checksum link                                                                                             | One local display alias; unlinked identical title/checksum stays separate; B cannot inherit A link                       |
| Search/sort/filter/star/hide                           | Current preference/query; Online filter matches Mac `path == nil` (absence of offline copy), while label/playability separately reports truly unavailable voice | Selection freezes that visible order; later query/hide does not rewrite the accepted queue                               |
| Rename/DELETE account                                  | Current captured account and command ACK                                                                                                                        | Failed/stale ACK does not stop current playback; positive DELETE retires only matching current ID                        |
| Remove cache                                           | Current account cache, exact shared-mutex unpinned tree                                                                                                         | Server job/source remains; active pins deny deletion                                                                     |
| DELETE_LOCAL before catalog commit                     | Exact WAL+tombstone and owned file birth                                                                                                                        | Recovery restores the exact pair; no source/export deletion                                                              |
| DELETE_LOCAL after catalog commit                      | Exact durable tombstone, not any similarly named directory                                                                                                      | Recovery removes only that tombstone; live owner/open-file/pin conflicts defer                                           |
| Keep offline/download                                  | Exact current variant/hash/bytes and opaque signed grant, immutable content destination                                                                         | Bad/expired/foreign grants fail; ENOENT-only linked restore; concurrent pinned existing artifact is retained             |
| Export/Share trimmed guest/account voice               | Exact cached artifact/descriptor/pin, no full-timeline reuse requirement                                                                                        | Exact bytes copied; unsupported Save leaves media playing; Share unknown ACK remains retained until inspected quiescence |
| Native Save cancellation/collision/write/account fault | New exclusive chosen descriptor and exact original window/owner                                                                                                 | No overwrite; discard only its new partial; source and unrelated destination stay untouched                              |

## Delivered player state/queue/pin lifecycle

| Trigger                                 | State/effect                                                                                                             | Authority retained/released                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Select Library or fresh personal intake | `preparing` descriptor before asynchronous work; no URL/count before verified source                                     | Personal owned request or exact artifact intake fence                                        |
| Verified source open                    | `buffering`, generation-tagged loopback URL, independent selected timeline                                               | Exact FD/pin held; actual playing event starts history                                       |
| Actual playing / buffering / pause      | `playing` only after actual event; buffering adds no count; pause retains source                                         | Source/pin remains held                                                                      |
| Seek/Restart/source switch              | Revision-tagged seek or new generation with preserved logical position/paused intent                                     | No new count except accepted actual repeat/AB seek followed by playing                       |
| Play next/add/remove/move/clear         | Authoritative pending occurrences/revision changes only                                                                  | Current URL/generation and pin unchanged                                                     |
| Next/natural end                        | Sleep expiry wins; track repeat seeks zero; queue repeat appends prior ID; shuffle uses controlled current pending index | Replacement source owns a new generation; duplicate Next while preparing ignored             |
| Error/unavailable source                | Safe error; user may reselect/keep-offline/review another source, no automatic billed processing                         | Failed opened source released; uncertain native work remains protected by its owning adapter |
| Stop/new source/owner retirement/quit   | Abort old request, retire event generation, stop old stream and wait owned analysis/copy acknowledgements                | Close exact descriptor then unpin; account retirement preserves guest source/queue           |

Timeline example: a 60-second original retains sample ranges
`[[441000,882000],[1764000,2205000]]` (10–20s and 40–50s). Its voice output is 20s:
voice 5s maps to original 15s; voice 10s maps to original 40s; original 30s clamps
to voice 10s. No 60:20 proportional scaling is used. A voice with a missing map
instead uses its verified 20-second output coordinate, blocks comparison only and
remains seekable/exportable/shareable. Direct original retains its own 60-second
timeline even when voice duration/conversion is unavailable.

Grant/pin order: acquire exact artifact pin under shared cache mutex → resolve
matching artifact/path/SHA → native path/fingerprint and FD hash → issue opaque
loopback capability → verify current identity before each range → abort/wait any
owned silence/acknowledgement consumer → destroy streams/close FD → release pin.
Paused playback does not shortcut this order. The new slow-reader test proves
portable stream/FD revocation; actual Windows locking/ACLs remain N3.

## Candidate codec matrix, not native certification

| Source contract                                          | Producer/consumer                                                                               | Portable check                                        | Actual Windows result                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| Normalized original AAC-LC/M4A (`audio/mp4`)             | Owned Prepare/personal CPU encode → Electron audio                                              | Hash/bytes/duration and strict child declarations     | [ ] N4 listen/decode/seek                     |
| Voice MP3 (`audio/mpeg`)                                 | Qualified model result + CPU encode / cloud output → Electron audio                             | Output hash/bytes, known duration, map admission      | [ ] N4 listen/quality/cuts                    |
| Existing original MP3/WAV/FLAC/AAC/OGG/WebM declarations | Exact authorized original metadata or private retained original → MIME allowlisted range source | Exact metadata/path/bytes/hash, no voice substitution | [ ] N4 each supported container/codec variant |

Codec/driver/device compatibility, actual audio fidelity and synchronization cannot
be certified by synthetic AAC/MP3 bytes or DOM playback promises. This matrix
fulfills the source-format decision/deliverable while all actual results stay open.

## Current audit delta and checks

Added portable proof, with no production implementation changes in this return:
`library-export-fault-matrix.test.ts` (trim guest/account/no-map, unsupported Save
preserving actual guest playback, cancelled picker/copy, ENOSPC/EIO, owner loss,
source replacement); `library-pagination-bounds.test.ts` (82 pages and 4096 rows);
`library-thumbnail-abort.test.ts` (fixed deadline/owner abort, zero publication);
`playback-range-lifetime-matrix.test.ts` (real loopback exact ranges/Host/method/query,
eight paused readers/backpressure, bounded concurrency and once-only FD release).
The existing corrupt-late-cache-publisher case now also keeps the prior artifact
pinned throughout failure. No parallel domain controller or production success
stub was added.

The initial broad audit run at 23:08:29 passed 387 tests and failed one of 388
across 43 files while Main ingress gained a sender-current callback; the old bridge
assertion expected only one argument. Concurrent whole-tree typecheck also found
the in-progress updater.check/action-map integration outside this task. Those
moving-source checkpoints are not claimed as green. The settled rerun below is
the current portable source checkpoint.

The coordinating pre-audit checkpoint passed 1476 tests/179 files at 22:43:50,
with types/lint444/format; the extended signout bridge passed 4/1 at 22:45:48.
Those are historical coordinated counts, not a claim about this audit's new tests.

### Settled portable checkpoint

The final coherent Desktop regression started at **23:19:33** and passed
**388 tests / 43 files** in **10.09 seconds**, including the 23 added cases and
current five-case preload/ingress bridge. Whole-component `npm run typecheck`
passed. `npm run build` passed in this audit return. Scoped five-file
`oxlint --deny-warnings` reported zero warnings/errors. The four new suites,
strengthened artifact test and owned task/evidence documents were formatted;
local relative references and unchecked native sections were validated.

The shared Chrome Cloud/account regression started at **23:10:26** and passed
**110 tests / 4 files** with this exact command:

```sh
cd chrome-extension
npx vitest run tests/cloud-provider.test.ts tests/browser-cloud-provider.test.ts tests/browser-processing-bridge.test.ts tests/account-realtime.test.ts
```

Meaningful new portable fault/boundary invocations included:

```sh
cd windows-desktop
npx vitest run tests/library-export-fault-matrix.test.ts tests/library-export.test.ts tests/local-save.test.ts
npx vitest run tests/playback-range-lifetime-matrix.test.ts tests/playback-media.test.ts
npx vitest run tests/library-pagination-bounds.test.ts
npx vitest run tests/library-thumbnail-abort.test.ts tests/library-thumbnails.test.ts
npm run typecheck
npm run build
npx oxlint --deny-warnings tests/library-export-fault-matrix.test.ts tests/playback-range-lifetime-matrix.test.ts tests/library-pagination-bounds.test.ts tests/library-thumbnail-abort.test.ts tests/library-artifacts.test.ts
```

The export invocation's source scope is the real helper plus actual file handles;
the media invocation uses actual loopback HTTP, not a Windows decoder. The broad
43-file regression additionally exercises all matrix-named controller, transport,
UI, ownership and listening suites; it is not a full component test-count claim.

Every implementation/code row and delivered artifact in W13/W16/W18 now has an
explicit matrix entry and portable proof. The current audit found no remaining
required production-source gap in those tasks. The unresolved work is N1–N4 on
the connected Windows target and authorized live services, plus acceptance of
real installed/package/device behavior under W34. Those rows stay unchecked;
code-complete does not mark a Windows release ready.
