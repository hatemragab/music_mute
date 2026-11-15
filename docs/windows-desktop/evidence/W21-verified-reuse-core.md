# Evidence: W21 — Verified reuse and community publication core

- Date: 2026-10-09; macOS arm64, Node 24.18.0 / TypeScript 6.0.2 / Vitest 4.1.11.
- Source base `c0218633`; unrelated dirty work preserved. No commit, deployment, real media/account/grant or Windows execution.
- Status: production core complete; consumer main/Chrome intake/playback composition pending.
- Reuse source/test checkpoint digest: `d7509b9c966e625f44e51563c7cb0b17925b2a3ab8e3a10d672958edab4ec55d`.
- Scope: `windows-desktop/src/main/reuse/**`, shared reuse contracts and tests; additive personal capture/receipt/outbox source. Companion guest validation was extracted into a pure module with legacy reexports, preserving macOS contracts and avoiding Mac helper imports in the Windows bundle.

## Production behavior

`createWindowsReuse` binds the existing Library catalog/cache/actual artifact pins, authenticated account transport, current-user DPAPI guest capability store, shared `YouTubeCommunityClient` commands/full-snapshot sockets, verified signed media tools, owned whole-tree CPU validation and one immutable guest-pair producer. Renderer paths, models, UID choices, grants and runtime modules are not accepted.

The decision order is local, account, community. Local candidates need the actual private pair's current model/recipe/full-timeline receipt and video/acquisition identity, both immutable hashes and compatible durations. Optional exact acquisition identity also binds format/audio-track/default/language and input bytes/hash. Trimmed and legacy pairs remain playable but cannot be relabeled as current full-profile reuse/save evidence. A title/URL alone is not a source receipt. Account hits require the authorized ready snapshot, canonical YouTube source, current recipe/profile, known compatible output duration and download permission; the reviewed recipe binds the current model without inventing a server field. Existing Library grants/cache are reused and full hashes are verified under exact playback pins.

Community delivery retains the fixed reviewed profile, video/provenance/source-verification declaration, compatible durations and private R2 expiring grants. The shared transfer verifies exact length/hash without a Firebase bearer. Actual signed Prepare CPU decode/probe checks both files under whole-tree native ownership; no CPU inference exists. Unconfirmed tool shutdown preserves the incoming workspace. Shared provenance is explicit and cannot be republished as locally verified acquisition.

Guest adoption reads source descriptors without modifying them, hashes/copies/fsyncs a fresh private `.pending` pair and atomically publishes under the native cache mutex. W22 reservation and a temporary parent-directory pin cover rename/catalog races. It uses the existing Library catalog; failed private partials are individually validated before bounded cleanup. Published pairs survive a lost catalog acknowledgement. Concurrent owner/source requests share the operation but hold separate reference-counted playback leases. Account/owner changes fence late grants/copies/results. Corruption and invalid grants remain failures; optional service outages are bounded visible misses allowing the existing local path, without creating separation intake or paid cloud fallback.

## Publication and recovery

`WindowsCommunityPublisher` accepts only actual locally acquired YouTube pairs with current model/recipe/source proof. Files, legacy evidence and previously shared/contributed media cannot enter publication. It journals stable local/producer UUIDs before commands; provider grants and capabilities never enter journals or safe views. Native ACL/cache-mutex metadata is bounded to 64 records and 512 MiB pending media; pending source trees stay protected by the Library pruner callback. Declaration and playback release are separate: deferred Chrome media may declare immutable bytes, but PUT waits for exact job/hash playback acknowledgement.

Existing reservation, upload-grant, raw full-snapshot follower wait, conditional R2 PUT and completion/HEAD semantics are reused. Lost reservation replies reuse the producer UUID. Ambiguous PUTs can be confirmed by completion. Only a known missing/expired contribution rotates that UUID, preserving prepared media identity. Retry deadlines/attempts are bounded; explicit Retry retains local identity. Discard aborts transport and removes only publication intent, preserving the local pair/global shared media. Actual Node SID/session/PID/birth plus nonce claims prevent concurrent publishers; confirmed changed/dead birth permits recovery. Updates require the same claim; stale writers cannot commit after discard. Safe views omit source paths, process identities, credentials and grants. W20 community-link association performs no inference.

## Executed checks

| Check                                                                | Result                      | Boundary                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop focused reuse/outbox/personal control/events/cloud transfers | 90 tests / 14 files passed  | Identity/profile/timeline mismatch, corruption, foreign/expired grants, source preservation, concurrent pins, owner changes, capture, lost requests, ambiguous completion, deferred playback and process-birth claims. |
| Desktop `npm test`                                                   | 591 tests / 77 files passed | Integrated headless source fixtures; no app/device/Windows execution.                                                                                                                                                  |
| Desktop strict typecheck/build/scoped lint/format                    | Passed, zero warnings       | Source bundles only; no native build/installer.                                                                                                                                                                        |
| Companion guest/community regressions                                | 42 tests / 2 files passed   | Preserved shared client after pure model extraction.                                                                                                                                                                   |
| Companion typecheck/build/scoped lint/format                         | Passed                      | No installed Chrome/native-host acceptance.                                                                                                                                                                            |

Temporary filesystem fixtures adapt Windows paths to synthetic Mac files; they establish descriptor/hash/fsync/atomic/cleanup logic, not Windows ACL, sharing, DPAPI or mutex behavior. Existing signed transfer tests include corrupt downloads and expired/foreign grants.

## Remaining composition and acceptance

Root owns reuse before new inference, Chrome/native playback lease handoff, exact playback publication release, captured-scope community owner-link save, publisher wake/retry lifecycle and safe consumer views. No global producer grant or account owner is inferred merely from a local Ready event. The completion producer preserves the original submit UID/generation; shared guest adoption does not invent auto-save ownership. Task integration boxes remain open.

W34 must verify actual Windows 10 22H2/Windows 11 x64 filesystem/DPAPI/guardian/pins, real authorized local/account/community reuse/publication, Chrome synchronization, restart and owner switching. These code checks establish no live service, release, GPU, account or shared-media proof.
