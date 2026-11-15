# Evidence: personal intake, verified reuse and storage recovery

- Date: 2026-10-09; macOS arm64, Node 24.18.0, TypeScript 6.0.2, Vitest 4.1.11.
- Source base: `c0218633`; shared dirty work preserved. No commit/publication.
- Historical source/test cohort before the final native idle/count continuation: 75 personal/storage/reuse/cloud-media/Library/Outbox/Prepare/shared-client files; SHA-256 `0ebab3d8dbc2e8803f88ede99db95e288971b40578a0eb51314afb41eef36500`. This records source bytes, not a release artifact.
- Status: implemented source checkpoint; portable checks passed. Windows/GPU/installation/listening acceptance pending.

## Source behavior

The actual personal child consults the existing guest Library and optional community protocol before acquisition/inference. A fully hashed/pinned full-timeline pair is copied into the current request with a new completion receipt. An exact original-only hit skips acquisition and still uses normal guarded DirectML processing. Missing backend/Firebase configuration leaves local cache usable; claimed corruption fails rather than authorizing another-source fallback. Provenance remains explicit; private/trimmed/shared-source media cannot become a new canonical contribution.

Fresh eligible contributions are staged with playback deferred and stable producer request identity. Trusted exact voice playback is the separate release authority. Publisher bounded state and activity/subscriptions cover metadata/mutation/drain promises and awaited disposal. Personal idle proof includes publisher activity. State subscription describes this instance's writes; another process's Ready event requires an explicit snapshot read.

Picker staging reserves 64 entries/512 MiB across unfinished copies before bytes, with existing per-file/expiry/free-space limits. Exact consuming Node and file/directory birth are recorded. Source growth is refused; one-use capabilities move only into protected owned work. User source is read-only. Expired capability metadata is removed only with its exact reclaimed staging directory.

Account `.part`/metadata, personal `.pending`, shared adoption/download and the Advanced workspace bind creation birth before bytes. Old unbound records stay protected; replacement birth is an error. Local-delete tombstones follow durable catalog authority under the same cache mutex. Canonical immutable results survive lost rename/catalog acknowledgement. Recovery validates completion owner/request/captured scope and actual hashes; old scratch requires the exact Native Job exit certificate.

W13 staging, community validation and W19 silence copying share `CloudScratchWorkspace`. Its separate 64-entry/512 MiB CPU-workspace reservation is distinct from the 2,000,000,000-byte voice cache and picker staging. Reservations/pins survive copy, native handoff/probe, upload and consumed readonly result FD close. Before a second decoder launches in one directory, prior marker/proof is retired only after full-tree exit, so it cannot authorize new-child cleanup. Scope invalidation/disposal are awaited. Unknown native launch acknowledgement keeps protected scratch/capacity; Node death or missing paths do not prove native exit. No user-source deletion or HTTP status polling was added.

Guest playback/pins survive account changes. Missing/corrupt backend trim maps no longer discard valid account voice metadata. Original standalone can carry `voiceDuration:null`; trimmed voice needs an actual declared/cached duration. New private engine timeline proof stays strict. Prepare packaged keys/runtime metadata/source use the sealed resource reader; mutable runtime/model/capsules keep their separate checks.

## Executed checks

The full-suite rows below are earlier passing source snapshots. The final writer/unsafe-close additions have their own scoped record below; the shared integration suite is still being updated by its owners.

| Directory/command                                                                                    | Result                       | Boundary                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `windows-desktop`: `npm test`                                                                        | 967 tests / 124 files passed | Headless source snapshot, real temporary byte/hash/copy/pin/journal logic, injected Native/codec ports. |
| `windows-desktop`: `npm run typecheck`                                                               | Exit 0                       | Strict current source.                                                                                  |
| `windows-desktop`: `npm run lint`                                                                    | Exit 0, zero warnings        | Component source/tests/scripts.                                                                         |
| `windows-desktop`: `npm run build`                                                                   | Exit 0                       | JS bundles, no native compilation/installer.                                                            |
| `windows-desktop`: `npm run test:package-fixtures`                                                   | 2 passed                     | Renderer/preload boundaries.                                                                            |
| `windows-desktop`: selected runtime-bundle/Prepare-record/cloud-media/scratch/reuse/Library fixtures | 41 tests / 8 files passed    | Sealed-reader source fallback, exact creation/native/FD/trim metadata slices.                           |
| `chrome-extension`: `npx vitest run tests/youtube-community.test.ts`                                 | 44 passed                    | Existing HTTP bodies/bounds; absent pre-acquisition duration hint.                                      |
| `chrome-extension`: typecheck and scoped lint/Prettier                                               | Exit 0                       | Shared source compatibility, no installed extension check.                                              |

Owned formatting passes. The initial full format check reported five integration files; those were subsequently formatted by their respective owners. The later browser installer-maintenance type mismatch was corrected and the full typecheck passed again. The latest full format check reports five in-progress Advanced benchmark files, outside this checkpoint ownership; no full format success is inferred from a scoped pass. Earlier owned intermediate fixture/type failures were corrected and rechecked. Temporary synthetic artifacts were removed; no real user media, runtime/model download, enrollment or contribution was performed.

## Deferred target evidence

- [ ] Windows 10 22H2/Windows 11 x64 native compilation/signatures, ACL/reparse/hardlink/NTFS locks, DPAPI, mutex contention and full Job/keeper lifecycle.
- [ ] DirectML placement/current physical GPU/driver/model, actual codec quality/trim timing, cancellation and offline local execution.
- [ ] Installed fresh Prepare, desktop/Chrome reuse/account/playback/listening/export/share, restart/low-space and source preservation.
- [ ] Unknown native acknowledgement recovery: retained bounded capacity must not be force-cleaned by age/PID or advertised as certified exit.
- [ ] Genuine sealed/signed Windows payload and approved runtime descriptor inputs; source fixtures cannot replace release artifacts.
- [x] W19 silence writer admission/handoff uses the same birth/reservation/native-workspace hooks; code fixtures passed with injected Native/codec ports.

These checks establish no Windows, GPU, live API/R2, account or listening success. W34 records target results after connection.

## Final shutdown audit continuation

Unsafe shared workspace close now rejects `STORAGE_RECOVERY_PENDING` before releasing pins/reservation or declaring closed. Known-owner retry requires actual `Host.native.ownedTreeExited`; unknown owner/missing/failed proof cannot become idle. Cloud media retains failed cleanup in its activity and permits an explicit disposal retry only after proof. A pin-release failure after its own successful marker unlink remains non-idle and retries that exact lease without treating an arbitrary missing marker as exit authority. The scoped cloud/reuse/storage/silence command passed 24 tests across four files; strict typecheck and scoped lint/format/build passed. The subsequent full source snapshot had 984 passing tests and one active fleet fixture mismatch (new purged-tombstone retirement event), owned by the fleet implementation; do not call that full run a pass until its corrected fixture is rerun.

Each new decoder handoff also clears the cached previous owner. A two-decoder fixture keeps the first exit certificate positive while the second launch acknowledgement is missing; repeated close and storage cleanup preserve the actual bytes and pin. The first decoder's certificate never authorizes cleanup of that new unknown tree.

## Thumbnail and Outbox partial closure

`StoragePartialWriteAdmission` binds thumbnail `<hash>.image.<UUID>.tmp` and Outbox `<role>.<extension>.<UUID>.part` through the same write journal. The actual newly opened file birth is captured before copying bytes. One unfinished journal temporary may occupy each canonical slot, so retry cannot accumulate additional copies for a durable Outbox artifact. Admission bounds thumbnail temporaries to 16 files of at most 1 MiB each, and Outbox temporaries to 256 MiB per role; the existing 128 committed-thumbnail cap and durable Outbox accounting remain separate.

`beginPartialWrite` reclaims positively stopped known temporaries before admitting another copy; `recoverPartialWrites` also supports startup/maintenance batch recovery. A missing captured birth, changed file birth, live/uncertain writer or actual live consumer pin prevents deletion. Only closed temporary slots may use the partial-recovery cache/pin authority: durable Outbox directory retention still protects canonical copies, and canonical/source files are excluded. Inventory counts the temporary bytes once. No old unrecorded file gains cleanup authority from its name or age.

Root composition binds `library.thumbnails.setWriteAdmission(...)` and the fifth `WindowsOutboxMedia` constructor argument to the real Storage controller. Thumbnail misses without admission start no transfer; valid existing thumbnails remain readable. Outbox retain/release requires admission. Both copiers settle after the file handles stop, before exact temporary recovery.

At 18:01:57 on 2026-10-09, this command passed **57 tests across seven files**:

```sh
cd windows-desktop
npx vitest run tests/storage-partial-writes.test.ts tests/outbox-media.test.ts tests/library-artifacts.test.ts tests/storage-write-journal.test.ts tests/cloud-media-storage.test.ts tests/reuse-media.test.ts tests/storage-controller.test.ts
```

These use real temporary files/hashes/copies/journals and injected Native/process/codec ports. Cases cover thumbnail restart, interrupted Outbox retry, unbound/replaced temporary preservation, slot/count/byte quotas, actual live pins vs durable retention, mandatory admission and the second-decoder acknowledgement gap. Owned 69-file lint and formatting passed; JS build passed. A concurrent TypeScript snapshot contained only an in-progress fleet composition fixture error; that owner reports its correction. Full integration checks must be rerun after the other source changes settle, without inferring Windows/native/codec success.

## Generic atomic metadata closure

All 32 source call sites retain the existing `writePrivateAtomic(host,target,bytes)` API. It now delegates to `atomic-metadata.ts` with one fixed `<target>.atomic.lock` and one fixed `<target>.atomic.tmp`; each payload remains at most 2 MiB, lock reads at most 4096 bytes, and the per-process serialized queue at most 64 snapshotted payloads. The fixed SID-wide Native `metadata` mutex serializes commit/recovery across helpers/logons. Its lock order is caller cache/Prepare lease → metadata → direct file/process/path operations; this helper never attempts cache or Prepare while holding metadata.

The fsynced lock records actual consuming Node PID/birth/SID/session and its own file birth. The temporary creation birth is fsynced before payload bytes; exact size/digest and native file checks precede canonical rename. Live/uncertain Node identity, replaced files and unbound headers/temporaries stay `METADATA_RECOVERY_PENDING`; helper death or an abandoned mutex is insufficient. Incomplete prebinding remains bounded, preserves the prior canonical bytes and requires validated recovery authority rather than guessed deletion. Old unrecorded random temporaries do not acquire authority from this change.

Fixtures now explicitly distinguish metadata from caller-held cache/Prepare scopes and supply consuming Node identity. At 18:22:04, personal/storage/reuse/Library/history/cloud/Outbox plus atomic fixtures passed **229 tests/35 files**. At 18:26:10, the updated eight atomic cases plus Prepare/session/silence passed **111 tests/14 files**. Strict TypeScript, the full 386-file component lint, JS build and scoped formatting passed after this helper. These overlapping slices are not added together or described as a full-suite pass.

The log producer review retained existing `DiagnosticSpool` fixed metadata/100 MiB quota/1 MiB segments/seven-day retention/8 KiB records/1000 pending bound. The legacy stdout gzip maintainer has no consumer desktop invocation; its source was preserved. Native scope source/portable lease verification is separate team evidence, with actual Windows mutex/NTFS/ACL/DPAPI/helper loss still deferred to W34.

## Personal full-tree cleanup proof continuation

`DirectmlPersonalRunner.stop` now requires positive `native.inferenceIdle()` from
the actual helper previously bound to the exact personal role. Guardian-process
exit alone does not prove that Windows has finished terminating its nested
Python/FFmpeg/downloader tree. The native operation checks the named role Job's
actual membership and allows only its owning Node and fixed native helper direct
peers to remain. It has no unbound-helper/PID-only success path.

Absent proof, remaining descendants or a failed query causes
`STOP_UNCONFIRMED`; the active record, GPU reservation and protected scratch
remain. A later explicit shutdown retry reuses the completed guardian-stop
operation but must obtain a fresh positive role-idle query before cleanup/release.
The legacy worker supervisor's shutdown behavior is unchanged.

At 19:00:55, the seven-file history/Library/personal source slice passed **73
tests**. The personal runner fixtures cover successful guardian exit followed by
false role proof, helper query failure and missing method; none releases the
guard, and only a subsequent positive proof permits release. Strict TypeScript
and scoped lint passed. These injected native fixtures establish no actual
Win32 named-Job/keeper/NTFS proof; delayed descendants, helper loss and native
cancellation remain deferred target cases.

## Fresh desktop completion intent continuation

`personal/playback-intents.ts` is a private transient authority, bounded to 16
unfinished intents and 32 retired request IDs. DesktopPersonalController mints
the submission UUID before awaited staging/acquisition/reuse and reports the
captured owner/account scope through optional trusted lifecycle hooks. A reuse
miss and its real submit retain the same UUID. Accepted job mapping, runtime
failure, explicit cancel and detach/dispose retire the corresponding authority.

The gate consumes only the existing pinned/full-hashed `onVerifiedPair` result
with matching installation, request, owner, job, original/voice digests and
captured account scope. It also requires the actual current desktop READY job's
matching audio hashes and the unchanged current window/playback epoch. Startup,
backfill, Chrome/fleet completion and an unrelated shared hit cannot mint this
authority. An intentional pre-acquisition reuse hit uses `consumeReuse` for the
same request; both paths are one-use. Manual playback change, account generation
change or window closure prevents old completion autoplay. Valid trimmed/local
files need no full-timeline reuse receipt for this desktop playback gate.

Application composition must connect these hooks, issue an explicit completion
reconcile after accepted mapping if the Ready pair raced ahead of the submit
acknowledgement, invalidate intents on manual player/window lifecycle changes,
and load the returned trusted Library track through the existing playback
provider. That integration is separate from the portable gate fixtures.

At 19:09:32, **22 tests across two files** passed for intent and desktop controller
ownership/reuse/lifecycle transitions. At 19:11:10 the five-file personal/Library
source slice passed **57 tests**. Strict desktop TypeScript, JS build and scoped
lint/format passed. These are code checks; no native media/Share/Windows listening
was run.

An additional reservation authority correction rejects explicit release of a
native-pending CPU workspace with no acknowledged owner even when its path and
parent Node are gone. This matches existing startup pruning behavior: missing
paths and Node death do not replace exact owned-tree proof.

## Native Share staging source continuation

`WindowsShareWorkspaceFactory({host,storage})` extends the existing write journal
and shared pin registry. It exposes `create(requestId,bytes,signal)`, `pending()`
and `restore(requestId,signal)`; returned workspaces match the native Share
controller's exclusive export destination, sealing, handoff, settlement and
retention port. Approved copies occupy only `share\\requests\\<UUID>` and the
fixed audio `media` filename/extensions. Their persistent reservation is bounded
to 16 requests/512 MiB total and 256 MiB per file, separate from voice cache,
picker and decoder budgets.

The actual consuming Node and directory creation birth are recorded before copy.
The closed copy is full-hashed and its Node file fingerprint is sealed before
native handoff. Handoff retains the journal/reservation and exact helper identity.
Node/helper death, missing paths, generic settle or a supplied renderer-shaped
terminal receipt cannot authorize cleanup. Settlement calls actual
`native.inspectShare` and matches terminal callback plus quiescence, request,
nonce, helper/window-owner births, path, size/hash and native file identity. It
also revalidates the sealed Node fingerprint/hash before removal. A lost cleanup
or pin-release acknowledgement keeps bounded state for exact retry; positively
removed files do not require an invented new native receipt. Restart restore
never shows Share again and refuses takeover of a live prehandoff copier.

At 19:28:38, the nine-file Share/journal/partial/storage/Library export/Outbox/cloud
and scratch reservation slice passed **67 tests**. It uses real temporary
bytes/files/hash/pin/journal logic with injected native Share receipts. Cases
include false quiescence, helper loss, forged supplied nonce/file identity,
wrong window/helper birth, replacement bytes, restart retention, live copier
refusal, budgets and pin-release retry. Strict TypeScript, scoped lint and JS
build passed at the source checkpoint. Native SDK/WinRT controller evidence is
recorded separately by its owning task; no native Windows compilation, Share UI
or actual target delivery was run here.

The later read-only `workspace.nativePending()` recovery getter distinguishes a
restored, positively safe prehandoff copier from a handed-off native consumer.
The live/uncertain copier still refuses restore. At 19:33:44, **17 tests across
the Share workspace and write-journal files** passed, including explicit dead
prehandoff discard without a native inspection or repeated Share UI. Scoped
Share lint/format passed. The application owner is running the current full
checkpoint; this later slice is not a full-suite or Windows acceptance claim.

## Background consumer intake continuation

OutboxController, PersonalCompletionProducer and the actual community publisher
accept an optional `consumersAllowed()` intake port. `createWindowsReuse` forwards
it to its publisher; omission preserves existing behavior. New account capture,
drain, completion reconcile, publication staging and retry do not start while the
port is false. An admitted copy/upload/claim may finish; a later record or new
publication/capture waits. Pending durable requests, original producer UUIDs,
retained copies and first-play permission are preserved. Maintenance gating does
not abort a current operation or discard its durable record; real account
retirement retains its existing authorization cancellation behavior.

All three controllers expose explicit `resume()` hooks for lifecycle settlement.
Completion events coalesce while paused, and publication holds at most 64
deferred exact job/hash playback releases without starting a metadata write.
Resume applies existing releases, while a later admitted stage applies the
matching release if the pair was not staged yet. Snapshots and retention reads
remain separate read-only operations. No timed HTTP status read was added.

Outbox `view().busy` now includes actual accepted capture/drain/restore promises,
including old-account operations still awaiting acknowledgement. A new scope
presentation cannot advertise idle while those promises remain. Disposal awaits
accepted restores as well as captures/drains. Completion and publisher retain
their existing activity subscriptions through admitted work; deferred work with
no current native/write promise is distinct from active work.

At 19:49:01, **66 tests across seven files** passed for Outbox intake/owner/busy
state, completion deferral/pins, actual publisher/factory policy forwarding and
desktop/browser publication compatibility. Tests include the real retry timer
under an injected clock, pause during an upload/catalog write, delayed old-owner
journal acknowledgement, first-play-before-stage and explicit resume using the
original durable identity. Strict TypeScript passed after correcting a precise
fixture promise annotation; scoped nine-file lint/format and JS build passed.
Application composition binds the common intake port and resumes after lifecycle
settlement; its final combined checkpoint is recorded separately. No Windows,
native, network publication or account action was performed.

## Guest intake scope and owner-watch continuation

The read-only audit found three concrete desktop boundaries: pending null guest
staging/reuse was aborted on login, submission dispatch could recapture a newer
account after awaited attachment, and a scope-fenced long poll could exit the
desktop owner watch permanently. Already accepted child guest jobs, staged-file
scope matching, request replay, private completion recovery and account outbox
ownership were separately traced and did not relabel guest/A work into B.

The corrected DesktopPersonalController records each intake's original scope.
Only non-null stale captures abort on an app account change; explicit owner
detach/Quit still aborts all. Trusted submit passes that captured scope through
the SessionClient's private `submission_authority` discriminant. Explicit guest
stays null even when login happens during role attachment. Explicit account
authority must match the current account generation before and after attachment;
Chrome cannot select account authority. Current submit clients always emit the
discriminant; older omitted private frames retain their legacy handling. No
renderer scope field, account credential or new backend route was introduced.

Scope changes retire the old event watcher. After the actual session scope ACK,
`scopeChanged(scope)` verifies it remains host-current and resumes an existing
owner subscription with an initial full snapshot. Delayed old delivery and old
scope ACKs cannot overwrite/restart it. Initial disconnected scope ACK connects
without creating an unregistered owner watcher; accepted submission starts it.
Explicit detached owners do not resume until new accepted work registers them.
Root application composition now passes the captured third argument and calls
the two scope hooks around its serialized actual authority command.

At 20:30:45, **73 tests across eight files** passed: desktop-personal,
session-control, personal-controller/events/storage/intake-journal,
outbox-completion and personal-playback-intents. New fixtures exercise a real
DesktopPersonalController guest file copy/reuse wait during login, strict
SessionClient wire construction and delayed attachment dispatch, A→B refusal,
an in-flight child guest separation through login/B/signout with its original
null completion context, current/stale ACK watcher recovery and detached-owner
retirement. Native/engine ports are injected; no native processing or user
account action was executed. Existing actual private bytes/hash/receipt fixtures
cover scope-bound staged input and canonical completion recovery.

Scoped five-file lint/Prettier, source build and `git diff --check` passed.
TypeScript passed at the 20:29 checkpoint. A later concurrent global run reported
only the separately owned `desktop-shortcuts.test.tsx` PreferencesView `error`
fixture mismatch; no personal/session type error was reported. The application
owner's stable full checkpoint must follow that correction.

The [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were retrieved on 2026-10-09 before this private IPC contract extension. Applicable
rules: 104 (authorization), 167 (JSON), 106/107 (compatible extension), 123 (avoid
ambiguous absent/null semantics, addressed by the discriminant), and 214
(duplicate-safe event consumption). HTTP routes/methods/statuses, bearer schemes
and OpenAPI hosting do not apply to this native authenticated IPC. Existing wire
naming/error contracts and SID/peer/owner-generation fences are retained. This
preflight and injected tests do not establish native or production compliance.

Still deferred: real Windows named-pipe/logon/DPAPI/native execution, GPU and
Windows UI processing/account journeys in W34. No runtime/model download,
installed-state mutation, enrollment, live publication or native/device check
was run for this slice.
