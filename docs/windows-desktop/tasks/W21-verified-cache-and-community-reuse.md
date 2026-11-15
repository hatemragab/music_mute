# W21 — Port verified local, account and shared YouTube reuse

- Status: code-complete / Windows pending (production source and portable checks complete; native/live acceptance deferred).
- Code dependencies: [W12](W12-local-files-and-youtube-processing.md), [W20](W20-background-account-saving-and-outbox.md).
- Accepted scope points: P17.
- Execution phase: A source implementation and portable checks; W34 native/live acceptance remains deferred.
- Evidence: [verified reuse and community publication source](../evidence/W21-verified-reuse-core.md), [production personal reuse/recovery checkpoint](../evidence/W12-W21-W22-intake-reuse-recovery-2026-10-09.md).

Checked implementation/code rows refer to actual production entry/source and meaningful portable tests in the [final closure matrix](../evidence/W14-W15-W20-W21-final-source-closure-2026-10-10.md). A dependency's pending Windows proof does not block source work. Every real Windows/live/release acceptance row below remains unchecked.

## Existing behavior and design consequence

Reuse is safe only when source, model, recipe and timeline match. Optional account/shared services must not become prerequisites for local processing or a way to accept stale/wrong audio.

## Read before editing

- [chrome-extension/src/companion/account-cache-restore.ts](../../../chrome-extension/src/companion/account-cache-restore.ts)
- [chrome-extension/src/companion/youtube-community-client.ts](../../../chrome-extension/src/companion/youtube-community-client.ts)
- [chrome-extension/src/companion/youtube-community-provider.ts](../../../chrome-extension/src/companion/youtube-community-provider.ts)
- [chrome-extension/src/companion/youtube-community-outbox.ts](../../../chrome-extension/src/companion/youtube-community-outbox.ts)
- [chrome-extension/src/companion/community-playback.ts](../../../chrome-extension/src/companion/community-playback.ts)
- [chrome-extension/src/companion/community-publisher.ts](../../../chrome-extension/src/companion/community-publisher.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Port the current reuse decision order across verified local cache, authorized account restore and eligible shared YouTube media; document each hit/miss/ineligible result and its owner/source requirements.
- [x] Validate source identity, model digest, recipe, duration/timeline, artifact length/hash and trim policy before declaring a playable hit. Reject mismatches rather than treating URL/title similarity as identity.
- [x] Preserve bounded guest/account capabilities and community publication/outbox semantics. Keep private local files out of shared publication paths.
- [x] Treat optional service unavailability as a bounded miss when current policy permits local acquisition/processing; never switch to paid cloud processing implicitly.
- [x] Coordinate downloads/publication with active playback pins, cancellation and account generation. Prevent duplicate work for concurrent requests and stale late responses.
- [x] Return safe transparency about reused versus newly processed media without exposing backend storage/provider URLs or internal credentials.

- [x] Bind the production factory to personal/Chrome intake, lease handoff, captured owner-link saving, playback publication release and safe consumer views; verify composed journeys.

## Code validation checklist

- [x] Test exact hit, model/recipe/source/timeline mismatch, corrupt download, expired grant, optional service outage and owner-switch cases.
- [x] Verify private local media cannot enter community paths and a claimed shared hit is verified before playback.
- [x] Test idempotent concurrent reuse/publication and bounded cleanup of failed partials.

## Windows acceptance — deferred until W34

- [ ] Verify real local/account/shared cache hits and misses on Windows with exact source/output identity evidence.
- [ ] Confirm synchronized Chrome playback after reuse and ordinary local processing when optional services are unavailable.

## Detailed agent execution handoff

### Implemented composition without a dependency cycle

The reuse/publication factory composes W16 cache/pins, W20 completion/save/owner-link and W22 protection/admission. Actual personal/Chrome intake uses the real verified factory before new acquisition/inference and hands validated tracks to player/browser ownership; Main binds association/protection and shutdown. No second downloader or catalog was introduced. A fixture provider is not a verified live cache hit; the final matrix separates tested source from native/live proof.

Source map: [factory](../../../windows-desktop/src/main/reuse/factory.ts), [decision controller](../../../windows-desktop/src/main/reuse/controller.ts), [strict receipts/pair](../../../windows-desktop/src/main/reuse/receipts.ts), [guest adoption](../../../windows-desktop/src/main/reuse/guest-adoption.ts), [owned media validation](../../../windows-desktop/src/main/reuse/media.ts), [publication](../../../windows-desktop/src/main/reuse/publication.ts) and [shared community protocol](../../../chrome-extension/src/companion/youtube-community-client.ts).

- [x] Bind local → authorized account → eligible community decision order to actual desktop and shared-extension intake. A bounded miss returns to the existing LOCAL path only when its current mode/policy/duration permits it; never start paid cloud work implicitly.
- [x] Validate the actual private full-timeline receipt, current model/recipe, source/video/acquisition variant, lengths/hashes and original/voice timing before playback. Legacy receipt omission remains playable but reuse-ineligible; trimmed output cannot be represented as full timeline. Preserve community provenance/source-verification flags instead of labeling contributed audio as locally verified.
- [x] Bind readonly source descriptors, signed R2 transfers and owned CPU media checks to immutable guest adoption in the existing catalog. Reserve storage and protect pending/final publication across rename. A tool shutdown uncertainty retains protected scratch for recovery, not a PID-only cleanup guess.
- [x] Transfer distinct reference-counted leases for concurrent owner/source requests into actual player/Chrome ownership. Await cancellation/quiescence before disposing native helpers. Owner changes cancel/fence late delivery, while an existing independent player pin retains its correct artifact.
- [x] Stage publication only from actual locally acquired YouTube proof. Exclude private files, unknown/legacy profiles, trimmed results and already contributed/shared sources. Journal stable command UUIDs before HTTP, keep grants transient, and coordinate reserve/follower/producer work through the existing raw full-snapshot protocol.
- [x] For Chrome, immutable declarations may be staged while publication is deferred, but PUT must await the exact successful playback job/output-hash acknowledgement. Wake the bounded durable publisher without making publication or account saving a playback prerequisite.
- [x] Wire producer claim/dead-birth recovery, Retry/Discard, retained source directories and W20 exact-output owner-link save. A stale process claim may be reclaimed only after actual PID/birth mismatch, not timeout/PID existence alone. Expired contribution recovery preserves prepared bytes and rotates only the producer identity when the server's known lifecycle permits it.
- [x] Present reused/newly processed origin and unavailable/failed reasons safely in English/Arabic, without storage URLs, capability tokens or raw paths.

### Meaningful fixture proof

Use exact local/account/community hits and misses with wrong model/recipe/video/format/audio-track/default/language, malformed/legacy/trimmed receipt, unknown output duration, corrupt or truncated download, expired/foreign R2 grant and an unavailable optional service. Include same source concurrent requests with independently released pins, A→B before grant/copy/adoption, main disposal during owned decode, lost catalog acknowledgement, wrong playback-release hash, lost reservation reply, ambiguous immutable PUT and known expired contribution. A corrupt claimed hit is an error, not permission to try a different audio source silently.

Run `tests/reuse*.test.ts`, outbox/community and signed transfer fixtures plus companion community client regressions; inspect the actual main/Chrome binding and awaited native cleanup. Existing 90/591/42 checks are checkpoint evidence. W34 later proves real cache hits, R2 delivery/provenance, Chrome synchronization, two callers, restart/publication and no new inference or unexpected account charge when reuse succeeds. No live contribution or shared-media mutation occurs during portable fixtures.

## Production lookup and publication closure

Implementation continuation 2026-10-09: actual personal-child pair/original-only lookup, absent-origin local cache, guest playback fences, shared bounded CPU-workspace validation, deferred publication state/activity and immutable pair recovery are implemented and portable-tested. The final matrix now reviews actual Main/Chrome first-playback/source-proof and independent waiter/pin cancellation, while W34 machine rows remain open. The [earlier checkpoint](../evidence/W12-W21-W22-intake-reuse-recovery-2026-10-09.md) remains dated source evidence, not a live hit.

- [x] Bind both personal intake paths before acquisition/runtime activation/GPU
      admission, using one identity/hash/timeline/pin authority. A post-processing
      result lookup does not close pre-acquisition reuse.
- [x] Make `findCached` strictly no-network, including account cache restore;
      misses/corruption cannot download, START or infer. Keep cache-only and normal
      lookup request identities distinct when deduplicating.
- [x] Account invalidation aborts account-derived requests/pins only. Guest
      in-flight lookups and playback pins survive A→B; final disposal drains both.
- [x] Bind deferred publication to trusted job/peer/source ownership and first
      actual voice playback. Shared reuse is not a new contribution; private or
      incompatible trimmed media never becomes a browser/community full timeline.
- [x] Test composed entry call order, zero network on restore miss, same-owner
      concurrent requests, account switch and overlapping playback/export/cleanup.
- [x] Test verified guest hits without account/backend configuration and crash
      after pair rename before catalog publication through the real completion
      scanner. Each playback lease releases independently. Return after W20/W22/
      W27 composition; community unavailability cannot disable existing cache.

## Completion record

- Implementation files and review: production reuse controller/factory/receipt parser, verified Library and shared transfer/media adapters, immutable guest adoption, DPAPI capability store and durable process-owned publisher; scoped personal capture corrections.
- Commands/results and evidence: historical 90 Desktop/591 headless/42 shared companion checks remain dated evidence; the final matrix records 312/35 current targeted source checks plus strict type/lint/build/boundary proof and new shared-waiter faults.
- Unrun native/toolchain checks: Windows ACL/sharing/DPAPI/guardian/pins, real account/community round trips and installed Chrome synchronization remain W34.
- Remaining limitations and next task: actual Windows/R2/account/community/Chrome synchronization remains W34. Main, pre-acquisition personal/Chrome, guest catalog, current-owner link saving and exact voice publication source composition now exist and are mapped.

## Final shared-lookup and lifetime closure

- [x] Separate each caller's cancellation from the shared operation. A first pending or resolved caller cannot abort another waiter or release its not-yet-delivered pins; the last pending waiter aborts actual shared work.
- [x] Hold one verified anchor lease until all waiting callers retain/cancel, then preserve independent player/browser references. Owner changes fence account-derived work only; final disposal waits actual shared native cleanup and pin-release promises.
- [x] Test pending/resolved first-caller cancellation, last-caller delayed teardown, account replacement even when an adapter ignores abort, and delayed pin release. No extra downloader/network/cache job or source-identity fallback was added.
- [x] Review every implementation/code/detailed/lookup/publication/provenance/deliverable row against actual receiving source and meaningful tests in the final matrix; all real Windows/live rows remain open.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
