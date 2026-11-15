# W22 — Implement storage budgets, pins and safe cleanup

- Status: code-complete / Windows pending; final Native/Main receiving and frozen whole regression passed.
- Code dependencies: [W16](W16-complete-library-and-metadata.md), [W20](W20-background-account-saving-and-outbox.md), [W21](W21-verified-cache-and-community-reuse.md).
- Accepted scope points: P18, P21.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [final named requirement/receiver/proof return](../evidence/W22-final-native-library-cleanup-2026-10-10.md), [current requirement/proof ledger](../evidence/W22-W30-2026-10-10-source-closure.md), [integrated recovery checkpoint](../evidence/W12-W21-W22-intake-reuse-recovery-2026-10-09.md) and historical checks below.

Handoff boundary: source presence is not task completion. Execute source work
only when implementation is explicitly authorized. Machine checks remain in W34;
do not skip required code recovery work merely because Windows is disconnected.

## Existing behavior and design consequence

The existing 2 GB cache default, whole-GB settings, LRU policy and pending-original bound are product constraints. Windows file locking and case/reparse behavior require native follow-up.

## Read before editing

- [chrome-extension/src/companion/cache-budget.ts](../../../chrome-extension/src/companion/cache-budget.ts)
- [chrome-extension/src/companion/cache-settings.ts](../../../chrome-extension/src/companion/cache-settings.ts)
- [chrome-extension/src/companion/cache-mutator.ts](../../../chrome-extension/src/companion/cache-mutator.ts)
- [chrome-extension/src/companion/job-workspace.ts](../../../chrome-extension/src/companion/job-workspace.ts)
- [chrome-extension/src/companion/sync-outbox.ts](../../../chrome-extension/src/companion/sync-outbox.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Port the 2 GB default and whole-GB cache budget controls, with transparent usage categories and the existing byte-unit semantics. Keep runtime/model/rollback accounting distinct from evictable media cache.
- [x] Implement LRU eviction with pins for active playback, export, Share, processing, download, sync, outbox and update consumers. Preserve the existing bounded pending-original policy, including its 256 MiB cap.
- [x] Add clear-eligible-cache and item-level removal that operate only on app-owned eligible data. Never delete user source/export files, active artifacts, credentials or another consumer's runtime.
- [x] Make pin/journal/eviction updates crash-safe and serialized with cache mutations. Handle missing/corrupt entries and deferred deletion while Windows holds files open.
- [x] Guard cleanup against reparse points, directory replacement and path aliases; enforce root containment using native validation. Bound scratch, partial downloads and logs independently.
- [x] Expose low-space, pinned-space and cleanup results with safe recovery guidance. Do not claim freeing disk space until deletions are confirmed.

## Code validation checklist

- [x] Test LRU ordering, all eight pin purposes, actual owner birth, budget changes, pending-original cap, active-file deletion refusal and unpin-after-crash recovery at the portable boundary.
- [x] Fault-test concurrent download/sync/playback/eviction, open-file errors, missing entries and malicious path indirection.
- [x] Verify eligible cache cleanup allowlists exclude selected input/export/runtime/model/credential paths, including forged eligible labels.

## Windows acceptance — deferred until W34

- [ ] Test real Windows open-file semantics, low disk and cleanup while playback/sync/worker consumers are active.
- [ ] Confirm reported usage/freed space and preservation of source files, pinned data and shared runtime.

## Agent execution contract — planning review 2026-10-09

Current source includes storage model/settings/inventory/files/reservations/
controller and an integrated `write-journal.ts`; LibraryPins and private
personal/account publication already have lifecycle hooks. Main now composes
Storage and account cache admission. The continuation adds creation-birth leases,
tombstones, bounded picker staging and cloud/shared CPU scratch/native handoff.
Runtime/model partials keep their fixed Prepare mutex/pin/size/digest checks;
thumbnails retain 128-file/1 MiB bounds and worker diagnostics keep their existing
segment/quota/retention limits. Broad rows retain producer/UI and W34 acceptance
review beyond the recorded portable source slices.

| Policy/authority  | Required invariant                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice budget      | Default 2,000,000,000 bytes, whole decimal-GB settings. Only voice cache counts; original/runtime/model/rollback/outbox categories stay distinct.                                                 |
| Pending originals | Global 256 MiB bound for all retained outbox copies, including cleanup failure/discarded records until actually released.                                                                         |
| Admission         | Current source keeps 3 GiB free headroom plus incoming reservation. Report unknown free space as unavailable; do not claim this is a measured Windows minimum.                                    |
| Pin owner         | Actual consuming Node/Electron PID + creation time/SID/session, never its helper's PID. Playback/export/share/processing/download/sync/outbox/update and parent directory overlaps protect bytes. |
| Durable retention | Outbox journal supplies protected original/result directories across crashes; live-process pin pruning alone cannot release pending durable copies.                                               |
| Scratch owner     | Exact role/nonce/Node birth/native Job tree-exit certificate. A dead PID/helper or missing directory alone cannot prove descendants stopped.                                                      |
| Share consumption | A distinct native terminal/quiesced Share receipt, actual SDK inspection and sealed copy/helper/window-owner bindings. Decoder Job exit, Node death and missing paths do not prove Share stopped. |
| Delete            | Shared native cache mutex spans inventory, pin/reservation recheck and actual allowlisted deletion; exact fingerprint/native ACL/reparse/hardlink verification before unlink.                     |
| Freed space       | Report confirmed logical deletion separately; displayed freed bytes are capped by actual volume free-space increase. Open-file errors remain deferred.                                            |

### Implementation order and ownership boundaries

- [x] Admit only `share\\requests\\<UUID>` staging trees and the approved
      `media.<mp3|m4a|webm|ogg|aac|wav|flac>` slots. Reserve at most 16 persistent
      copies/512 MiB total and 256 MiB per file before bytes, independently of the
      voice cache. Record actual Node/directory birth, seal exact hash/file
      fingerprint and retain the write journal at native handoff. Native-pending
      copies never acquire Node-death or generic-settle cleanup permission.
- [x] Provide `WindowsShareWorkspaceFactory.create/pending/restore` for the native
      Share controller. Restore does not show Share again; prehandoff restore
      refuses a live/uncertain copier. Settlement re-inspects the actual SDK and
      requires exact terminal callback/quiescence, nonce/helper/window owner,
      source path/hash/bytes and native file identity before exact copy removal.
- [ ] Revalidate the composed main/UI Share lifecycle, restart recovery, unknown
      native acknowledgements and real WinRT consumption/open-file behavior in
      W16/W34. Synthetic receipts do not establish native Share success.

1. [x] Audit `LibraryPins`, cache-lease, storage inventory/files/reservations,
       personal storage, account cache, reuse producer and outbox retained roots.
       Keep one cache mutex/pin interpretation across desktop, Chrome and agents;
       do not add an independent cleanup registry that bypasses existing consumers.
2. [x] Close production admission wiring in every media writer. Reserve voice bytes
       and pin the planned exact final directory before `.pending`/`.part` copy;
       hold through hash/fsync/atomic rename/catalog commit. Account result download,
       personal result and shared reuse must each use actual hooks, not optional
       Windows success defaults.
3. [x] Integrate the existing write journal with real account `.part` and
       personal result `.pending` writers under the cache mutex. Persist actual
       Node writer birth before bytes can be created; mark settled only after that
       copier stops. Recover only fixed validated journal locations whose writer is
       settled or positively dead/replaced; uncertain liveness stays protected.
       These locations are Node-only; do not use Node-death proof for decoder scratch.
4. [x] Implement durable local-delete tombstone recovery. Current delete source
       renames result directory to `<job>.<transaction>.deleted` before catalog
       deletion. If catalog still names the pair and canonical directory is absent,
       restore the exact tombstone after validation; if catalog deletion is durable,
       remove only its owned tombstone. Conflicting canonical/tombstone identities,
       multiple candidates or live pins must fail closed. Never infer authority from
       a suffix or age alone.
5. [x] Integrate workspace markers for personal, cloud/reuse, Prepare/download
       and silence work; require exact native full-Job exit proof before descendant
       cleanup. Corrupt markers are a reported recovery error, not permission to
       recursively delete. Release pins only after actual cleanup/teardown settles.
       Personal/cloud/reuse/Advanced and W19 silence copies use the existing
       admission/birth/before-launch/owner hooks. Unsafe close preserves pins and
       activity until positive full-tree proof; unknown-owner acknowledgement gaps
       remain recovery-pending. Portable code fixtures pass; native operation stays in W34.
6. [x] Finish source bounds/recovery for staged picker inputs, incomplete
       downloads, write/tombstone/workspace journals, thumbnails and logs. Inventory
       labels unknown/partial data conservatively; unbound/replaced/live or
       uncertain files remain protected rather than being force-cleaned.
       Picker and CPU scratch each reserve 64 entries/512 MiB. Thumbnail and
       Outbox copiers now bind exact temporary birth through
       `StoragePartialWriteAdmission`: one unfinished temporary per canonical
       slot, 16 thumbnail partials/1 MiB per file and 256 MiB per Outbox role.
       Positively stopped recorded files are recovered before retry/admission;
       unbound/replaced/uncertain files stay protected. Review the remaining
       generic metadata now uses one fixed lock/temp per bounded target and a
       separate SID-wide metadata mutex, actual Node/file birth, 2 MiB payload,
       4096-byte header and 64-entry queue. Existing consumer diagnostic quota/
       segmentation/retention is preserved; the legacy gzip maintainer is outside
       this consumer path. Actual native/target maintenance evidence remains W34;
       this checked source row does not infer a machine result from fixtures.
7. [x] Review persistent access/LRU index and settings corruption behavior,
       reservation expiry through exact process birth, budget lowering, pinned-full
       admission and explicit cleanup confirmations. Budget change alone must not
       delete data; automatic incoming voice admission may evict eligible voices.
8. [x] Reconcile file removal with Library availability and linked account
       restore: evicted original removes comparison/export availability honestly,
       evicted voice may retain an online row. Metadata/user source/export/runtime/
       credentials are not ordinary voice-budget eviction targets.
9. [x] Complete Storage UI safe usage/low-space/pinned/deferred/error states,
       W29 `hasLiveConsumers` and update/rollback pins. Only an exact own update pin
       may be excluded from maintenance checks, with matching consuming process birth.

### Specific fault tests and expected outcomes

- [ ] Decimal units/default/whole-GB input; unrelated usage categories; oldest
      eligible voice with deterministic tie-break; no eligible bytes while pinned;
      over-budget lowering without immediate deletion; global pending-original cap.
- [x] Every file/directory pin purpose, parent/child overlap, real consumer vs
      helper birth, PID reuse/dead process and uncertain liveness; outbox crash-midcopy
      durable roots. Unknown proofs protect bytes rather than prune them.
- [x] Simultaneous playback/Chrome range/export/outbox/download/personal/reuse/
      eviction. Pin, reservation and mutation ordering prevent rename/unlink gaps;
      new pins cannot enter between final check and deletion.
- [x] Write faults before journal, after journal, partial copy, fsync, rename,
      metadata/catalog publication and release. Recover only exact abandoned `.part`
      or `.pending`, never an already-published immutable artifact or another writer.
- [x] Tombstone faults before/after rename and catalog commit, failed rollback,
      repeated recovery, two tombstones, conflicting canonical pair and active pin.
      Restore-or-delete follows durable catalog authority, not directory name alone.
- [x] Workspace child survives Node/helper death, wrong nonce/birth certificate,
      denied query and later confirmed exit; no descendant cleanup before proof.
- [x] Windows-like EPERM/EBUSY/EACCES, disk-full journal, file replaced after
      inventory, case/ADS/device/UNC alias, junction/hardlink and corrupt metadata:
      deletion refuses unsafe/changed paths and reports deferred/error accurately.
- [x] Partial unlink success with no measured free-space gain; unrelated volume
      changes; source/export/runtime/model/credential allowlist exclusion and bounded
      huge-tree traversal. No false freed-space claim or broad force-removal.

### Historical planning code-only check record

On the Mac, 2026-10-09, this exact command passed **50 tests across nine files**:

```sh
cd windows-desktop
npx vitest run tests/storage-policy.test.ts tests/storage-files.test.ts tests/storage-controller.test.ts tests/personal-storage.test.ts tests/personal-timeline.test.ts tests/library-provider.test.ts tests/personal-controller.test.ts tests/personal-control.test.ts tests/personal-events.test.ts
```

Those fixtures prove selected policy/orchestration/path-error/pin/trim/scope
behavior with injected native ports. They do **not** test the unintegrated write
journal, tombstone recovery, actual Win32 deletion, ACLs or GPU descendants.
At that historical planning checkpoint, read-only `npx tsc --noEmit` failed at
`tests/fleet-controller.test.ts:491`: mutex methods now exist, but the fixture's
`acquireMutex` returns `Promise<string>` instead of
`Promise<ConsumerMutexLease | null>`. The typed lease needs scope, nonce, actual
process identity (including SID/session/PID/creation time) and abandoned status.
No TypeScript success was claimed at that historical planning checkpoint, and no production/fixture
code was changed during that documentation phase. Earlier passing component
checks remain historical; re-run after future source changes and coordinate the
typed fixture correction with the fleet implementation boundary.

### Trimmed result retention and save/export distinction

- [x] Treat verified trimmed local voices as ordinary voice-cache artifacts for
      budget/LRU, playback and Export/Share pins. Full-timeline reuse eligibility is
      not a prerequisite for protecting an actively consumed trimmed file.
- [x] Failed/unsupported account saving must not delete the successful trimmed
      voice, its comparison map or an original needed by an active playback/export.
      Explain full-timeline Save/reuse incompatibility; it does not imply that
      valid local trimmed playback or Export/Share is unavailable. Keep canonical
      YouTube reuse/community publication trim=false.

If later accepted scope explicitly adds compatible trimmed-private ingest in
W20/W05, its staging must reuse durable outbox roots/256 MiB original accounting.
That conditional extension would need capture/copy/upload/replay/commit/release
fault tests with exact owner/map/artifact identity. Do not add a separate unpinned
queue, unbounded copies, or a new current-parity requirement from this note.

See the [W12 source audit and conditional W20/W05 extension](W12-local-files-and-youtube-processing.md#trim-account-saving-and-export-parity-audit)
and [W16 action distinction](W16-complete-library-and-metadata.md#trimmed-local-library-actions-and-w20-return-boundary).

### Deferred Windows checks and reviewable deliverables

- [ ] Actual native cache mutex contention across app/Chrome/roles, NTFS open-file
      deletion, process/helper/keeper crash, complete Job exit and stale pin recovery.
- [ ] Real low-disk/volume accounting, directory replacement/junction/hardlink,
      active playback/sync/worker/update and repeated restart during write/delete.
- [ ] Deliver usage-unit/category table, pin/admission lifecycle per producer,
      exact cleanup allowlists, write/tombstone/workspace recovery matrix, source
      preservation fixtures and W34 measured/free-space evidence.

Primary constraints checked: [Windows reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points)
can redirect resolution, so string prefix containment is insufficient. The
[Job Object lifetime rules](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
do not make PID death an exit certificate. MusicMute's conservative fingerprint,
mutex/pin and native tree proof requirements are additional application policy.

## Write-journal and startup/maintenance closure

The latest [copier/unsafe-shutdown evidence](../evidence/W12-W21-W22-intake-reuse-recovery-2026-10-09.md#thumbnail-and-outbox-partial-closure)
records real media producer hooks and 57 portable fault tests. Production uses
`beginPartialWrite(relative,bytes)`/`recoverPartialWrites(canonical,signal)` for
the two additional closed file families. Startup/maintenance can call
`recoverPartialWrites(undefined,signal)`; another decoder's old certificate, a
temporary suffix, age or helper/PID death cannot grant cleanup authority.

Generic metadata callers keep `writePrivateAtomic`; the implementation now
serializes one fixed `.atomic.lock`/`.atomic.tmp` through the Native `metadata`
scope. Record actual consuming Node and file birth, fsync temporary birth before
bytes, and verify size/digest before canonical rename. Never acquire cache/
Prepare while metadata is held. Unknown prebinding remains bounded and explicit
recovery-pending; do not invent cleanup authority or add new quarantine files.
The [generic metadata evidence](../evidence/W12-W21-W22-intake-reuse-recovery-2026-10-09.md#generic-atomic-metadata-closure)
records the caller regression and separate target boundaries.

- [x] Audit every cache/outbox/reuse/personal/import/export writer against the
      actual `beginWrite` lease, final publication and settlement contract.
      Handoff to native processing binds exact process birth; no Node-liveness
      shortcut or successful abort before whole-tree cleanup.
- [x] Reconcile recognized incomplete writes and local-delete tombstones before
      catalog presentation and during maintenance recovery; main's startup hook
      already exists and requires composed fault tests rather than duplication.
- [x] Resolve catalog/files/metadata/pins atomically under existing cache mutation
      authority. Unknown, replaced, linked or still-owned files remain deferred;
      journal corruption does not authorize broad recursive cleanup.
- [x] Cover independent scratch/input/download/log bounds as well as the unified
      voice budget and global pending-original bound across account partitions.
- [x] Test crash before/after publish, writer death/native handoff, stale birth,
      metadata rename, tombstone recovery, busy pins and backup reservation. Run
      final scoped lint/build after journal changes; earlier focused passes alone
      do not close the integrated storage task.

## Completion record

- Implementation files and review: `windows-desktop/src/main/storage/**`, shared storage contracts, LibraryPins/cache-lease, private personal/account admission hooks and main Storage composition; owned Native/storage receivers are complete. The final GUI pending-original sum binding and whole regression are complete; see the final dated receiver ledger.
- Commands/results and evidence: historical 50-test planning record above; the linked integrated checkpoint passed 965 headless tests, strict typecheck/lint/build and actual intake/write/tombstone/native-handoff/cloud/reuse recovery fixtures.
- Unrun native/toolchain checks: all Windows mutex/ACL/reparse/file-lock/free-space/Job/cross-process checks; no real media/source cleanup was performed during planning.
- Remaining limitations and next task: W34 native cleanup/GPU/listening plus genuine-package evidence. Unknown native acknowledgements retain bounded capacity; no PID/age cleanup guess is permitted.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Final named source return — 2026-10-10

The [final receiver ledger](../evidence/W22-final-native-library-cleanup-2026-10-10.md)
traces every source row to entry/authority, implementation, meaningful portable
proof and an explicit native-only gate. It includes post-effect reconciliation,
strict advisory LRU, exact artifact publish/abort, local tombstone rename/final
cleanup, durable receipt/ACK recovery, all-owner retention and Main/headless
shutdown receiving. The 124/10 owned and 7/1 composed Cloud checks passed; the
corrected last whole-suite failure is preserved in Root W33 evidence. Root owns
the final whole-product rerun. None of the Windows rows above is promoted.

### Independently owned last receiving row

- [x] Bind GUI Storage `pendingOriginalBytes` to the actual all-owner unreleased
      original journal sum and pass recovered aggregate-over-256-MiB scan/reserve
      refusal fixtures. Agent admission and normal Outbox.create already enforce the
      bound; they do not prove the missing GUI recovery defense. Backend owns this
      exact Main/shared helper change and Root owns its final whole-suite return.

## Final Root source closure — 2026-10-10

The shared all-owner pending-original receiver passed30/three at04:27:03,
including exact256-MiB admission, +1-byte refusal without mutation, unreleased
discarded copies and malformed journals. Final whole Desktop2135/232 at04:28:29,
whole typecheck/lint/format/build, package5 and the actual9/12graph gate passed.
See [final W33 evidence](../evidence/W33-final-source-regression-2026-10-10.md).
All actual Windows acceptance remains unchecked.
