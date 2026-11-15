# W16 — Implement the complete local and account Library

- Status: code-complete — every required source/code action is mapped and portably verified; Windows/native/live acceptance remains pending in W34.
- Code dependencies: [W04](W04-electron-shell-and-navigation.md), [W12](W12-local-files-and-youtube-processing.md), [W15](W15-usage-policy-and-realtime.md).
- Accepted scope points: P12, P14.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [Library source/code fixtures](../evidence/W16-library-code.md), [current action/ownership audit](../evidence/W13-W16-W18-source-journey-audit-2026-10-09.md).

Handoff boundary: checked rows preserve earlier source evidence. Execute source
work only when implementation is explicitly authorized. Windows machine checks
remain separate and do not block code-only development on the Mac.

Checklist reconciliation: every source/code row below maps to W16 L01–L16 in the [exhaustive requirement matrix](../evidence/W13-W16-W18-requirement-closure-2026-10-09.md). Native/live observations are separate unchecked W34 cases. Historical subset counts remain dated evidence.

## Existing behavior and design consequence

Library behavior spans local catalog, account snapshots, verified downloads and native UI. Current parity includes thumbnails in multiple player surfaces and the exact visible filtered/sorted order for playback.

## Read before editing

- [chrome-extension/macos/DesktopWorkspace.swift](../../../chrome-extension/macos/DesktopWorkspace.swift)
- [chrome-extension/macos/DesktopMediaViews.swift](../../../chrome-extension/macos/DesktopMediaViews.swift)
- [chrome-extension/src/companion/desktop-catalog.ts](../../../chrome-extension/src/companion/desktop-catalog.ts)
- [chrome-extension/src/companion/account-cache.ts](../../../chrome-extension/src/companion/account-cache.ts)
- [chrome-extension/src/companion/account-cache-restore.ts](../../../chrome-extension/src/companion/account-cache-restore.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Merge local and account-backed items through explicit stable identities/ownership, retaining correct offline/online availability and avoiding duplicate display of the same linked result.
- [x] Implement search, newest/title/most-played sorting, offline/online filters, starred/removed views, favorite/unfavorite, hide/restore, rename and deletion with current macOS semantics.
- [x] Implement thumbnail acquisition/sanitization/cache limits and safe fallback in Library, Now Playing and Up Next. Never render remote metadata as HTML or leak private image grants.
- [x] Implement verified download/offline retention, export/save/share and original availability. Differentiate remove cached copy, delete local item, hide account item and delete account data; use appropriate confirmations.
- [x] Make selection and Up Next use the exact current visible order. Define behavior when filtering/deleting/reordering the playing item without resurrecting removed rows or skipping unpredictably.
- [x] Keep account-owned records partitioned and local files usable signed out. Apply reconnect snapshots atomically, preserve loading/error/empty states and avoid status polling.
- [x] Use Windows-safe filenames, collisions and export destinations; no source-file deletion or arbitrary path capability exposed to the renderer.
- [x] Render truly unavailable voice copies honestly; disable unavailable voice Play/queue intake while retaining valid original play/export/share independently.
- [x] Permit exact linked restoration only for local ENOENT; permission/integrity failures cannot trigger grants or transfers. Match variant checksum and bytes before requesting a grant.

## Code validation checklist

- [x] Test merge/dedup, filters/sorts, favorites/removed restoration, offline state and owner switching with representative catalogs.
- [x] Test visible-order queue derivation, active-item deletion, thumbnail failure, filename collision and expired-download grants.
- [x] Headless-test all Library actions and distinguish destructive server actions from local cache removal.

## Windows acceptance — deferred until W34

- [ ] Verify large Libraries, real downloads/exports/share, thumbnails, keyboard interaction and offline relaunch on Windows.
- [ ] Confirm user source files remain intact and account switching cannot expose prior-owner Library/media.

## Agent execution contract — planning review 2026-10-09

The Library is an ownership-aware view over the shared local catalog, current
account snapshots and verified media cache. It must remain usable when History
is damaged, an account is offline or an older trimmed job lacks a comparison
map. Keep an honest row/error/availability state rather than failing the page.

| Contract      | Required invariant                                                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local pair    | Windows-user guest original/voice IDs, checksums/bytes, catalog, optional exact timeline/reuse/completion receipts; legacy pair remains playable but does not fabricate reuse/save eligibility.                                    |
| Account rows  | UID partition plus exact session generation; raw WebSocket full snapshots update the subscribed page, retaining other explicitly loaded pages. No HTTP status polling.                                                             |
| Merge/link    | Explicit local↔account link with matching output identity; equal title/SHA alone cannot merge owners or confer account access.                                                                                                     |
| Visible order | Search/filter/sort/starred/removed result IDs are the exact selection/Up Next order. Availability is recomputed honestly after eviction.                                                                                           |
| Playback      | Trusted main-only artifact ID/relative path/SHA/bytes/MIME, actual source duration, logical original duration, trim map and accountOwned flag. UI receives only an opaque scoped loopback URL, never a private path/backend grant. |
| Pin/export    | Exact artifact/path/SHA binding under shared cache mutex, held through hash/open/descriptor/export; release after the consumer really stops.                                                                                       |

### Implementation order and integration boundaries

1. [x] Trace shared DesktopCatalog/metadata/cache helpers and current Library
       model/store/cache/controller/provider/factory. Preserve one schema and
       explicit ownership partitions; main/controller already contain source
       composition that must be reviewed, not replaced by a parallel catalog.
2. [x] Review null guest `rememberPersonal` and completion receipts independent
       of Firebase scope. Catalog publish precedes Ready. Account links/outbox attach
       only under captured-current authority; guest media survives sign-out.
3. [x] Close loaded-page/reconnect behavior: per-page subscriptions, bounded
       dedup/order, snapshot gaps, stale cursors, A→B and stale request errors.
       `saveAccountJobs` replacing its partition must receive the merged loaded pages,
       not merely the latest Load More response.
4. [x] Validate favorites/hide/restore/rename/delete semantics, exact confirmations
       and visible queue order. Cache removal must not delete a server record; hide
       must not delete media; server account deletion must not delete shared catalog
       objects or user source files.
5. [x] Review immutable account media publication: repeated same job/variant/SHA
       reuses verified artifact identity; never rename over an existing pinned file.
       Roll back only the writer's own newly created file birth. Downloads hold W22
       reservation/tree pins through byte verification and publication.
6. [x] Validate exact local→linked account cache fallback after local eviction.
       Fall back only for absent local bytes and an exact currently authorized
       account link/variant/SHA/size; ACL/integrity errors cannot be treated as misses.
       A newly account-owned playback grant must promptly fence account changes.
7. [x] Finish thumbnail hydration and UI in Library/Now Playing/Up Next: bounded
       visible rows/concurrency/pixel bytes, public sanitized sources, safe fallback,
       URL dedup and query/account epoch fencing. No private image URLs or HTML.
8. [x] Finish verified Save/Share through a trusted native exclusive destination
       descriptor. Hold the source pin, hash/copy/fsync and commit; user cancellation,
       name collision and late scope change cannot overwrite an unrelated file.
9. [x] Reconcile W22 delete tombstones and crash recovery before calling local
       item removal durable. Refresh availability/history after mutations without
       resurrecting a removed row or resetting corrupted History silently.

### Trimmed local Library actions and W20 return boundary

Mac `DesktopMediaViews.swift` exposes Export/Share whenever `track.path` exists;
`DesktopWorkspace.export/share` validates the local voice path and does not reject
trimmed tracks. The Windows Library must preserve that behavior for verified
trimmed local or downloaded account voices. Exporting the exact cached voice
does not require full-timeline reuse eligibility or a compatible account-save
profile, and must not silently expand/reprocess the voice into another timeline.

Account saving is separate. Current Mac local separation is untrimmed; its
outbox/capture clients and backend `/local-media-syncs` are full-timeline-only.
The present source does not establish a successful locally separated trimmed
Mac account-save path. An incompatible full-timeline Save/reuse needs an explicit
explanation; new private trimmed ingestion is not required by this parity audit.
The source findings and conditional W20/W05 extension boundary are detailed in
[W12 trim audit](W12-local-files-and-youtube-processing.md#trim-account-saving-and-export-parity-audit).

- [x] Keep trimmed local playback, exact-byte Export and Share eligible under
      ordinary trusted artifact/pin checks. Do not couple `canExport`/share to
      `reuseReceipt`, login, or `OUTBOX_PROFILE_UNSUPPORTED`.
- [x] Keep Save-to-account status/error separate from offline voice availability.
      Preserve artifacts and original/sample map during unsupported or failed saves;
      never turn a local pair into a full-timeline profile by changing metadata.
- [x] Preserve full-timeline Save/reuse validation and explain incompatible pairs
      without disabling valid trimmed playback/export/share. Keep synchronized
      YouTube reuse/publication untrimmed and preserve existing clients.
- [x] Test trimmed voice Export/Share without account/reuse receipt, downloaded
      trimmed account voice export with exact current-owner authority, failed save
      while local playback continues, and actual downloaded trimmed Job playback
      retaining its verified logical comparison ranges where available.

Only if later accepted scope explicitly requires new locally separated trimmed
Save-to-account should a compatible versioned private-ingest/outbox/Job-map task
return to W20/W05. That extension is not a current parity completion gate and is
not authorized by this planning note.

### Specific code-only tests and fault matrix

- [x] Local/account/link combinations, duplicate title/SHA but different owner,
      legacy receipts, trimmed null maps, favorites/removed views and count aliases.
- [x] Load More A+B; snapshot replacement of A only; cursor gap/reconnect; stale
      A response after account B; bounded 4,096 rows/loaded watchers and corrupt
      History. Page/catalog remains usable with explicit secondary errors.
- [x] Evicted original vs evicted voice, download still running, expired grant,
      exact linked restore vs corrupt local file; renderer availability/export flags
      reflect actual files and rights, not old catalog existence.
- [x] Repeat download/adoption into the same immutable destination, publish
      failure after another consumer pinned it, descriptor replacement while hashing,
      A→B→A remap and account loss during transfer/export: no wrong-media grant.
- [x] Thumbnail timeout/bad MIME/excessive size/dimensions/redirect and late old
      query completion; newest visible rows only, bounded inline data and fallback.
- [x] Save/Share cancelled/collision/short-write/full-disk; local delete fault
      before/after tombstone/catalog write; active playback/export/outbox pins; source
      files and exported destinations stay outside cleanup authority.

Extend model/controller/provider/artifacts/export/thumbnails/view fixtures and
trusted playback-source tests. Use temporary descriptors, injected grants/native
dialogs and raw-snapshot fixtures. Existing source builds/headless UI do not prove
actual dialogs, R2 transfers, ACLs or Windows media decoding.

### Delivered source artifacts

- [x] Deliver action semantics, ownership/merge examples, visible-order queue
      rules, download/export identity and deletion recovery tables in the exhaustive
      requirement matrix. Actual native results remain separately unrun.

### Deferred Windows evidence

- [ ] Large real Library, offline relaunch, account switching/reconnect, real
      granted downloads, thumbnails, native Save/Share and keyboard/RTL interaction.
- [ ] Concurrent playback/Chrome/outbox/export and cache eviction; exact artifact
      pins, actual Windows file-lock handling and no prior-account media access.

The task uses existing raw WebSocket/full-snapshot repository contracts.
[HTML media processing](https://html.spec.whatwg.org/multipage/media.html)
defines asynchronous playback/seeking events; Library availability and artifact
identity must be checked independently of an audio element's state. Actual codec
and listening proof remains W18/W34.

## Direct original and standalone trimmed voice closure

- [x] Implement Library Play original as a direct typed main/preload/UI action
      deriving Up Next from visible order; do not require voice-first loading.
- [x] Keep verified trimmed voice playable/exportable/shareable when its comparison
      map is null/missing. Disable unavailable original/voice comparison with clear
      reason; never reject standalone voice solely because conversion is absent.
- [x] Test direct original queue selection, trimmed missing-map playback/export/
      share, wrong artifact and unavailable comparison as separate decisions.

The [current source journey table](../evidence/W13-W16-W18-source-journey-audit-2026-10-09.md)
records implemented production bindings and exact fixture boundaries. The new
availability/fault and English/Arabic trim-save cases are code-checked. An evicted
voice does not hide Share original; current account authority still fences
account-owned bytes. Account DELETE stops only a matching active player after a
positive current-scope ACK. Actual Native Share/dialog/ACL/file-lock and complete
installed transports remain W34 work; no user source or successful pair is removed
by a failed or incompatible account save.

The coordinating agent's **22:19:16** stable full Desktop checkpoint passed
**1,424 tests / 174 files**, whole TypeScript/lint/format/build and two
package-boundary tests. See the current journey table for the exact scoped
fixtures and the still-unrun composed transport/native acceptance boundaries.

## Completion record

- Implementation files and review: `windows-desktop/src/main/library/**`, `src/shared/library-contracts.ts`, personal agent durable result hook and additive shared cloud transfer helper. Trusted playback/export interfaces reviewed with main/player and outbox owners.
- Commands/results and evidence: [W16 code evidence](../evidence/W16-library-code.md); 57 focused fixture tests, TypeScript and bundled source build passed.
- Unrun native/toolchain checks: all Windows acceptance rows above; native dialogs/ACLs/media/GPU/UI/live transfers were not run.
- Remaining limitations and next task: actual large/offline Library, native Share/dialog/ACL/pin/deletion recovery and listening acceptance. The extended composed bridge now includes a held queued account action revoked by an injected sign-out event through real playback authority; it does not contain a real AccountController or run Electron. All named source/code requirements map to the exhaustive matrix; native W22/W34 semantics remain unrun.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
