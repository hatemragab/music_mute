# Mobile audio processing tasks

Planned: 2026-09-09. Implementation authorized: 2026-09-10. Status: implemented and validated locally; external runtime proof remains explicitly separate below.

Approved: YouTube and local audio; explicit Remove music action; voice-only MP3 downloaded on demand.

- [Design and shared constraints](../superpowers/specs/2026-09-09-mobile-audio-processing.md)
- [Android implementation plan](../superpowers/plans/2026-09-09-android-audio-processing.md)
- [iOS implementation plan](../superpowers/plans/2026-09-09-ios-audio-processing.md)
- [Implemented backend API](../../backend/docs/api/audio-processing.md)

## Shared prerequisite

- [x] **MOB-B01 — Visible mobile outcome notifications.** Privacy-safe visible envelopes implemented with unchanged data keys/outbox behavior; payload and isolated delivery tests pass. Live Firebase/APNs delivery remains separate.
- [x] **MOB-B02 — Revision-fenced push deactivation.** Backward-compatible expectedBindingRevision body and both mobile clients prevent delayed logout cleanup from disabling a newer registration. Contract and isolated account-switch tests pass.

## Android

- [x] A01 — API contract, auth and safe errors.
- [x] A02 — Local import and immutable input validation.
- [x] A03 — Durable uploads and recovery.
- [x] A04 — Cloud history, detail and processing availability.
- [x] A05 — Cancel/retry and account isolation.
- [x] A06 — On-demand MP3 playback/export.
- [x] A07 — Push lifecycle and authenticated navigation.
- [x] A08 — Localized integration, JVM/lint/APK validation; Android runtime checks remain gated below.

## iOS

- [x] I01 — Codable API contract, auth and safe errors.
- [x] I02 — File import and immutable input validation.
- [x] I03 — Persistent upload and background URLSession recovery.
- [x] I04 — Cloud history and observable detail.
- [x] I05 — Cancel/retry and session fencing.
- [x] I06 — On-demand MP3 playback/export.
- [x] I07 — FCM/APNs lifecycle and authenticated navigation.
- [x] I08 — Localized integration and simulator validation.

## Acceptance and proof

- [x] Both source paths implemented; immutable import unit tests and saved-original simulator fixture flow pass. Original downloads never auto-submit. Native Files import picker selection remains a manual runtime check.
- [x] Strict limits, exact checksum and signed POST fields match backend contracts in local tests.
- [x] Lost-response/relaunch fixtures preserve logical create/retry intent.
- [x] All retained states, interruption and cancellation acknowledgement are represented.
- [x] Account/epoch tests fence cloud metadata/files/push callbacks across account changes.
- [x] Result download begins only on explicit action; retained files are not automatically deleted.
- [x] Matching English/Arabic resources, iOS RTL/large-text UI checks and visual review pass. Android runtime accessibility remains gated by device authorization.
- [x] Android JVM/lint/build pass with recorded commands.
- [x] iOS unit/UI checks pass on the exact authorized simulator; unsigned Release build passes.
- [x] Existing auth/original-download unit tests and basic iOS UI regressions remain green; live download/OAuth checks are not inferred from them.
- [x] Isolated API/storage flow tests pass and are labeled fixture evidence.
- [ ] Real S3 and deployed API behavior validated separately when available.
- [ ] Live FCM/APNs notification delivery validated separately.
- [ ] Android device/UI validation recorded only after explicit authorization of an Android target.

Current evidence: [execution ledger](mobile-audio-processing-execution.md), [Android validation](../validation/mobile-processing-android.md), [iOS validation](../validation/mobile-processing-ios.md). Original plans retain their task-by-task development sequence; this tracker records execution status. No commit, push, publication or deployment was performed.
