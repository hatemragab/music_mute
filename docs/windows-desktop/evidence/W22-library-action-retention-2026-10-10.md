# W22 Library action restoration and durable retention source return

Date: 2026-10-10. Source/code evidence only; no connected Windows, installed
account, native dialog, browser, GPU or release acceptance was run.

## Actual receiving fixes

- Main `LIBRARY_EXPORT` and `LIBRARY_SHARE` execute
  `restoreLibraryActionMedia` before choosing a destination or starting Windows
  Share. The actual PlaybackProvider must resolve the selected variant. Only
  `LIBRARY_DOWNLOAD_REQUIRED` permits the existing LibraryController grant/cache
  download path; permission, integrity and unavailable-source faults propagate.
  Restoration is followed by another selected-artifact validation. Export and
  Share still pin and validate their source through their existing controllers;
  a preflight is not pin authority or a guarantee against subsequent eviction.
- LibraryController `download` accepts an optional captured scope and caller
  AbortSignal. Existing callers remain compatible. Grant and cache transfer use
  the combined account/controller and window/app signal, with captured generation
  checked before requesting and after asynchronous work. Main also captures the
  exact host, Library, window and owner; Share cannot publish a late result into a
  replacement window/account. Voice and original variants remain distinct.
- Main and headless Personal now bind the same
  `durableLibraryRetainedDirectories` callback to LibraryPins. Under the existing
  SID cache mutex it reads all durable Outbox owners and Publication records,
  independent of optional live account/publication controllers. Unreleased
  outbox copies, their uncaptured source directories and pending publication
  source directories remain protected. A corrupt or unreadable journal refuses
  cleanup instead of producing an empty retained set.

## Executed checks

- First receiving slice: **66 tests/six files passed**, start03:39:19,
  duration688ms. The new fixtures compose actual LibraryController,
  PlaybackProvider and LibraryStore over synthetic ports: linked original
  restoration and subsequent exact pin, existing voice, permission refusal,
  same-user generation drift, account transition during a grant, caller abort,
  missing cache despite resolved download, stale window and removed remote input
  permission. Durable retention uses actual JournalOutboxStore parsing and
  validated publication records across two synthetic owners.
- Broader Library/export/Share/outbox/publication slice: **145 tests/12 files
  passed**, start03:39:56, duration8.98s. This includes existing export descriptor
  and cleanup-fault fixtures, playback sources and Share workspace behavior.
- Whole desktop `npm run typecheck` passed; seven owned source/test files passed
  `oxlint --deny-warnings` with zero findings and Prettier check.
- `npm run build` passed; `npm run test:package-fixtures` passed both actual
  renderer/preload bundle boundary fixtures. `git diff --check` passed.

These counts overlap. They do not replace the earlier frozen 2,052-test whole
Desktop checkpoint, which predates these receiving changes. Native cleanup,
post-effect storage reconciliation and advisory LRU returns remain separate W22
work; this document does not close the aggregate task.

## Later Library cleanup-lifetime receiving return

Native's stable factory now exposes `cleanupActivity()` and retryable `close()`.
Actual Main includes its active ownership in maintenance admission and positive
shutdown idle proof; after the command barrier it disposes/flushes the Library
controller, then awaits factory close before releasing the Host/native gates.
Standalone headless `WindowsPersonalReuse` also includes actual artifact-cache
cleanup activity in its idle result and awaits publisher settlement followed by
cache close. Rejected cleanup is propagated and can be retried; no failed-promise
memo or silent idle success is added. The existing headless cache admission-hook
binding was inspected and preserved.

The injected unknown-ownership headless receiving case and broader actual
Personal controller/activity/shutdown/maintenance/pending suite passed
**57 tests/seven files at03:58:25**, duration1.67s (first17/three also passed).
Whole TypeScript, six owned source/script/test files' lint, owned formatting,
source build and all five package/boundary/command fixtures passed. Native's
separate actual temporary-file Library deletion → shutdown retained-ACK replay
fixture remains part of its moving W22 return, not claimed by this injected test.

These later source bindings still need the final frozen whole Desktop run.

## Recovered pending-original admission return

Main now supplies its existing all-owner `WindowsOutboxStore` to
[`durablePendingOriginalBytes`](../../../windows-desktop/src/main/library/retained-directories.ts)
when constructing `WindowsStorageController`. The headless Personal Agent uses
the same helper instead of a separate aggregation. The journal's strict record
validation runs before summing every retained owner's original bytes, independent
of account login. Discarded copies continue to count until `copiesReleased` is
confirmed; released copies are excluded.

This closes the recovered-state validation omission, not a new-copy budget bypass:
existing `JournalOutboxStore.create` already enforced the global 256 MiB limit
before retaining a new copy. Storage's existing scan/admission validation now
also sees recovered records in Main. The sum is not added to inventory categories
or displayed storage totals; physical inventory remains their accounting source.
No native deletion, cache mutex, ownership proof or storage-controller gate was
relaxed.

The actual `JournalOutboxStore` plus temporary-filesystem Storage fixtures in
[`library-retained-directories.test.ts`](../../../windows-desktop/tests/library-retained-directories.test.ts)
and
[`storage-controller.test.ts`](../../../windows-desktop/tests/storage-controller.test.ts)
cover two durable owners, discarded-but-unreleased and confirmed released copies,
exactly 256 MiB admitted on scan/reserve, 256 MiB plus one byte refused before
eviction/reservation mutation, unchanged existing reservation bytes, and malformed
journals refused without writing a reservation. Existing physical media and its
metadata are counted once; pending journal bytes are not added again.

Executed from `windows-desktop/`:

- `npx vitest run tests/library-retained-directories.test.ts tests/storage-controller.test.ts tests/outbox-store.test.ts`:
  **30 tests/three files passed**, start04:27:03, duration1.62s. The first run's
  single fixture assertion expected media bytes without its existing metadata;
  the corrected assertion checks the actual media plus metadata inventory.
- `npm run typecheck` passed.
- `npx oxlint --deny-warnings` over the six changed source/test files passed with
  zero warnings/errors; their Prettier check passed.

These focused checks do not supersede the whole Desktop run begun before this
fix. Native Windows recovery and installed storage acceptance remain deferred.

## Deferred native proof

On connected Windows, evict an authorized linked original, then Export and Share
that original without launching inference or substituting vocals. Exercise account
generation/window cancellation during grant and transfer, pin/eviction races,
native destination/Share completion and a signed-out restart with durable pending
Outbox/Publication retention. The current fixtures establish code behavior only.
