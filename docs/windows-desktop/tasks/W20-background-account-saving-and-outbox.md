# W20 — Implement durable background account saving

- Status: code-complete / Windows pending (production source and portable checks complete; native/live acceptance deferred).
- Code dependencies: [W14](W14-complete-account-experience.md), [W16](W16-complete-library-and-metadata.md), [W18](W18-player-and-playback-queue.md).
- Accepted scope points: P16, P28.
- Execution phase: A source implementation and portable checks; W34 native/live acceptance remains deferred.
- Evidence: [outbox core source and fault fixtures](../evidence/W20-outbox-core.md).

Checked implementation/code rows refer to actual production entry/source and meaningful portable tests in the [final closure matrix](../evidence/W14-W15-W20-W21-final-source-closure-2026-10-10.md). A dependency's pending Windows proof does not block source work. Every real Windows/live/release acceptance row below remains unchecked.

## Existing behavior and design consequence

Local playback and account saving are separate outcomes. The existing outbox captures verified original/result pairs; Windows must preserve durability, ownership, retention and signed-transfer rules.

## Read before editing

- [chrome-extension/src/companion/sync-outbox.ts](../../../chrome-extension/src/companion/sync-outbox.ts)
- [chrome-extension/src/companion/local-sync-capture.ts](../../../chrome-extension/src/companion/local-sync-capture.ts)
- [chrome-extension/src/companion/local-sync-client.ts](../../../chrome-extension/src/companion/local-sync-client.ts)
- [chrome-extension/src/companion/warm-local-sync.ts](../../../chrome-extension/src/companion/warm-local-sync.ts)
- [chrome-extension/macos/DesktopOutboxWatcher.swift](../../../chrome-extension/macos/DesktopOutboxWatcher.swift)
- [docs/r2-storage/README.md](../../../docs/r2-storage/README.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Capture eligible completed local work into a durable owner/installation/generation-scoped outbox only after verified output is available; start playback independently of account-save success.
- [x] Persist the original/result pair, recipe/model/source identity and idempotency metadata atomically. Reference pinned app-owned files rather than arbitrary input paths and bound retained pending data.
- [x] Reuse current private R2 grant/upload/finalization and retry semantics, including opaque ETags/checksums and exact pair validation. Never embed storage credentials or expose grant URLs to Chrome/logs.
- [x] Handle offline/reconnect, expired grants, partial pair upload, finalize ambiguity, rate limits and process restart with bounded retry/backoff and no duplicate account records.
- [x] On logout/account switch, fence in-flight callbacks, suspend/cancel account transport as specified and keep pending records assigned to their original owner. Never upload A's pending media as B.
- [x] Expose concise saving/saved/retry states and safe user controls; keep required pending files pinned until finalize or explicit eligible cleanup. Reconcile outbox and catalog after crashes.
- [x] Preserve shared URL-media versus private local-upload deletion rules; do not treat account deletion as permission to remove global shared media.

- [x] Bind eligible personal completions with their original captured scope, Library association/pruner protection and watcher lifecycle to main/renderer; verify composed playback remains independent of saving.
- [x] Bind W21 verified community reuse/publication to the durable owner-link journal.

## Code validation checklist

- [x] Fault-test every journal/upload/finalize boundary, restart, expired grant and duplicate acknowledgement using isolated fixtures.
- [x] Test account switches at each stage and assert token/grant/media ownership fences plus no playback dependency on sync.
- [x] Test pins, pending-original retention limits, corrupted pair metadata and safe redacted progress/error serialization.

## Windows acceptance — deferred until W34

- [ ] Verify real authorized account save/download round trips, offline restart and resumed pair finalization on Windows.
- [ ] Test owner switching with designated accounts and confirm local playback begins before account saving finishes.

## Detailed agent execution handoff

### Implemented composition order and ownership

W16 supplies the real guest/account catalog and artifact cache; W12 supplies immutable result and submit/completion capture; W14 supplies account authority. W20 journal/transfers, W21 reuse/owner-link and W22 protection/admission foundations now compose in actual Main: completion producer → verified Library/pins → durable outbox → current-owner transport → durable account association, with storage protected by pending records. Native/live proof remains separate; a mock pin or no-op catalog callback would not close source composition. See [controller](../../../windows-desktop/src/main/outbox/controller.ts), [media copies](../../../windows-desktop/src/main/outbox/media.ts), [store](../../../windows-desktop/src/main/outbox/store.ts), [completion producer](../../../windows-desktop/src/main/outbox/completion-producer.ts), [shared sync client](../../../chrome-extension/src/companion/local-sync-client.ts) and [private storage guide](../../r2-storage/README.md).

- [x] Verify trusted session dispatch captures account UID/generation at **submission**, not at Ready. Desktop A jobs retain A's capture; Chrome and omitted scope are null/account-free even while desktop A is logged in. Persist capture in the request journal and final hash-bound completion receipt so main close/restart cannot select a different account for a finished result.
- [x] Bind startup, current-account restoration, personal-ready and fixed directory notifications to completion reconciliation. Pin and full-hash both artifacts before adopting the existing guest catalog or staging save. Null capture is permanently auto-save ineligible; same-UID new-generation resume is an explicit trusted operation, never B uploading A.
- [x] Build a visible **Save to account** action for eligible guest/local results. Capture the current authorized UID/generation only after this explicit action. Show verifying/preparing/saving/saved/retry/blocked/discard outcomes and known limits. Missing full model/recipe/source evidence must refuse an invented current profile while retaining local playback/export.
- [x] Build explicit **native share/export** for original versus voice with safe naming, exact artifact pin/hash and trusted native destination/share target. User chooses the action; no implicit upload or community publication. Keep grant/source paths and backend bearer out of the renderer. Dialog cancellation or share failure releases only its temporary resources and never edits selected source media.
- [x] Stage independent immutable private outbox copies and journal stable operation IDs before network work. Capture and transfer run independently of player admission. Protect original source until the durable copy checkpoint; protect copies until confirmed commit/association or explicit eligible discard.
- [x] Bind reconnect/receipt events and bounded retry deadlines without periodic live GET/status polling. Retry only endpoints whose existing implementation proves owner/request/body idempotency. Preserve create/grant request identity after lost responses; don't create a new intake UUID to bypass an expired reservation.
- [x] Bind shared-hit account saving to W21's existing community owner delivery/association, with exact output hash and captured scope. Private files never enter community contribution/delivery. Account deletion is not permission to delete global shared media.
- [x] Connect W22 protection callbacks and **global** retained-original/voice counters across all account partitions, including discarded cleanup failures. Finalization precedes durable association, which precedes private-copy release. Keep retry/discard UI actionable and safe.

### Required fault cases

Test submit as A → main closes → completion while signed out → restore A/new generation → resume once; submit as A → B → no B upload; Chrome start while A logged in → null completion forever auto-ineligible; guest result → explicit Save as B → one new B-owned record. Inject crashes before/after journal reserve, each copy/fsync/rename, capturing checkpoint, each conditional PUT, finalize receipt, catalog association and copy release. Check corrupt/legacy/trimmed pair, unknown schema, altered source descriptor, expired grant, partial pair, ambiguous 412/PUT/finalize, duplicate acknowledgement, Retry-After and bound exhaustion.

Exercise Save/share/export while playback and cleanup hold overlapping pins, while owner changes and while the native window is recreated. Pending original protection cannot be based only on the current account or Node liveness. Storage limits include all unreleased journals; rejected save does not stop playback. Discard warns about any already-created remote reservation using existing TTL semantics rather than inventing a cancellation endpoint.

Portable validation after changes: `tests/outbox*.test.ts`, reuse/publication, Library/pin/store and real headless player/account composition; typecheck/build and scoped lint/format. Existing 43/507 and later 90/591 checkpoints are dated code evidence, not real R2 or Windows proof. Deliver actual main/renderer/native-share adapters, immutable journal schema, owner/retention matrix, fault receipts and safe UI tests. W34 later verifies real account/R2 pair round trips, offline restart, native sharing/dialogs/file locks and playback-before-save on Windows using designated data and authorization.

## First-playback and original-owner integration return

- [x] Keep captured account saving and guest community publication as separate
      authorities. Account switching revokes account work; it does not cancel
      guest local reuse/playback or reassign guest completion to the new account.
- [x] Stage eligible fresh YouTube pairs deferred and release only the exact
      verified voice hash after the authorized actual voice-playing event. READY,
      completed processing and original-audio playback are insufficient.
- [x] For Chrome, obtain trusted session proof of original owner/peer birth/job/
      source/sealed pair before accepting PLAYBACK_STARTED; guessed UUIDs and
      another signed proxy cannot authorize publication.
- [x] Test no playback, original-only playback, wrong peer/hash/generation,
      duplicate playback acknowledgement, main Quit and restart between staging
      and playback. No premature upload or duplicate association.

## Completion record

- Implementation files and review: trusted outbox controller/journal/media copy/API/community/watcher/completion/effects, actual Main/Library/pins/Share/renderer adapters; original submit owner and known backend idempotency/private R2 rules mapped in the final matrix.
- Commands/results and evidence: historical 43/507 and later 90/591 checkpoints remain dated evidence; final matrix records 312/35 targeted fixtures and strict type/lint/build/boundary proof, including real producer effects/shutdown and owner/retention faults.
- Unrun native/toolchain checks: Windows ACL/mutex/file sharing/watcher behavior and real authorized account/R2/offline restart acceptance remain W34.
- Remaining limitations and next task: real Windows native sharing/watchers/ACL/file sharing and authorized account/R2 round trips remain W34. Actual Main/Library/UI and W21 owner-link/deferred publication are now bound; source checks do not claim live transfer or publication.

## Final first-playback and shutdown closure

- [x] Begin captured first playback and optional deferred publication independently through the actual Main completion-effects adapter. Await both real settlements under producer pins/activity/Host; storage/publication cannot delay first-play admission.
- [x] Keep actual desktop/Chrome voice-playing proof as the sole publication-release authority. Both adapters await acknowledged deferred stage and recheck immutable pair/hash/owner, so a concurrent completion stage cannot turn READY or original-only playback into upload permission.
- [x] After admitted completion effects settle during disposal, honor the aborted lifetime before starting a fresh account capture. Preserve already durable copies and the original UID; optional failure exposes only fixed public error material.
- [x] Review every implementation/code/detailed/first-playback/Share/retention/deliverable row against the final entry/source/proof/native matrix; no real account/R2/native publication is checked complete.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
