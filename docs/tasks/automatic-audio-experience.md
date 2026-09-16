# Automatic audio experience task tracker

Status: implementation authorized 2026-09-10; backend complete locally and packaged,
Android and iOS complete locally. The user reports the existing full
upload/S3/result-history flow works; that baseline does not validate the new tasks.
See the [execution record](automatic-audio-experience-execution.md) for actual evidence.

## Documents

- [Shared design and contract](../superpowers/specs/2026-09-10-automatic-audio-experience.md)
- Current backend behavior: `backend/docs/api/audio-processing.md`
- [Android plan](../superpowers/plans/2026-09-10-android-audio-experience.md)
- [iOS plan](../superpowers/plans/2026-09-10-ios-audio-experience.md)

## Backend tasks

- [x] B01 — Compatible source/display names, request identity, and rename contract.
- [x] B02 — Replay-safe actual processing timing and total elapsed presentation.
- [x] B03 — Authenticated mobile diagnostic reports, including pre-job failures.
- [x] B04 — Owner-scoped terminal deletion and durable exact-object cleanup.
- [x] B05 — Contract fixtures, compatibility regression, documentation and handoff.

## Android tasks

- [x] A01 — Typed contract and durable operation metadata.
- [x] A02 — Immediate URL/import intake and automatic multi-task pipeline.
- [x] A03 — Foreground transfers, silent progress notifications and recovery.
- [x] A04 — Compact cards, expanded timeline, timers, waveform/text motion and accessibility.
- [x] A05 — Acknowledged cancellation, bounded retries and diagnostic outbox.
- [x] A06 — Rename/delete plus on-demand playback/download/native sharing.
- [x] A07 — Integration, unit tests, lint/build and validation handoff.

## iOS tasks

- [x] I01 — Codable contract and durable operation metadata.
- [x] I02 — Immediate URL/import intake and automatic multi-task pipeline.
- [x] I03 — Background URLSession chaining, restoration and supported recovery.
- [x] I04 — SwiftUI cards/timeline/timing and audio-focused accessible visuals.
- [x] I05 — Cancellation, retries and diagnostic outbox.
- [x] I06 — Rename/delete plus on-demand playback/download/native sharing.
- [x] I07 — Integration, exact-simulator UI validation and unsigned build.

## Dependencies and execution order

1. B01 defines shared fixtures first; B02/B03/B04 extend those fixtures with timing, errors and deletion.
2. Android A01 and iOS I01 consume that contract. Platform-local coordinator/UI work can proceed with deterministic fixtures once the contract is fixed.
3. Each platform follows its plan's internal dependencies. No task may silently change the public contract for only one platform.
4. B05 closes backend compatibility. A07/I07 close mobile integration; new APIs must be deployed under separate authorization before claiming live new-flow success.
5. Processing-runtime changes are outside this mobile experience task.

## Design coverage

| User requirement                                   | Backend                   | Android     | iOS         |
| -------------------------------------------------- | ------------------------- | ----------- | ----------- |
| Start immediately for URL/import; no second button | B01 identity              | A02         | I02         |
| Multiple individual submissions                    | Existing queue + B01      | A01–A03     | I01–I03     |
| Background transfer and automatic handoff          | Existing queue            | A02/A03     | I02/I03     |
| Current stage, timing, ID and diagnostics          | B01–B03                   | A04/A05     | I04/I05     |
| Cancellation at all active stages                  | Existing cancel semantics | A05         | I05         |
| Bounded transient retry, any network               | Existing idempotency      | A02/A03/A05 | I02/I03/I05 |
| Preserved title and rename                         | B01                       | A01/A06     | I01/I06     |
| User deletion                                      | B04                       | A06         | I06         |
| Processed media only; fetch on user tap; sharing   | Existing output grants    | A04/A06     | I04/I06     |
| Audio styling, text/waveform animation, light/dark | No backend dependency     | A04         | I04         |
| Silent progress and detail timeline                | B02 timing                | A03/A04     | I03/I04     |

## Planning decisions and limitations

- Delete is an explicit confirmed terminal-item action; active items offer Cancel first. Private job media is cleaned up, while imported source files and external exports remain untouched.
- Initial local concurrency is two pipelines per account; this is an implementation default, not a cap on accepted submissions.
- Progress notifications are silent. Completion/failure retains the earlier recommended normal system-notification behavior; the shared spec identifies this interpretation explicitly.
- Android ongoing transfer notifications cannot be guaranteed impossible to dismiss on modern Android. iOS force-quit stops pending background transfers; recovery is on the next permitted execution/launch.
- The user later explicitly authorized running Android on the connected phone.
  Installation and launch were verified on Xiaomi 23043RP34G, Android 14/API 34;
  full processing/background scenarios remain unrun. iOS UI/device tests still
  use only iPhone 17 Pro / iOS 26.0 / `$IOS_SIMULATOR_UDID`.
- The later implementation request authorizes code changes and CapRover packaging.
  Commit/push/deployment, real data deletion, and cloud changes remain unauthorized.
