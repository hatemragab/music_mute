# Automatic audio experience: agreed design

Status: design agreed in conversation; planning only. No implementation is authorized by this document alone.

## Scope and plans

Improve the existing native Kotlin/Compose Android app and SwiftUI iOS app around local preparation, retained cloud history, and completed-result access. Keep client-side URL extraction. This is not a Flutter rewrite or a new server download service.

- Current backend behavior: `backend/docs/api/audio-processing.md`
- [Android tasks](../plans/2026-09-10-android-audio-experience.md)
- [iOS tasks](../plans/2026-09-10-ios-audio-experience.md)
- [Delivery tracker](../../tasks/automatic-audio-experience.md)

This design supersedes the older mobile processing design only for automatic submission, original-media presentation, result naming, deletion, and the UX described here. Existing authentication, file validation, cancellation acknowledgement, and account isolation remain requirements.

## Agreed product decisions

1. Pasting a supported URL or selecting a local audio file starts automatically; no Download, Submit, or Remove music confirmation button.
2. Accept individual submissions while earlier jobs continue; no bulk URL parser in this iteration.
3. URL inputs download locally, then automatically prepare, reserve a job, upload to S3, and confirm the upload. Local imports skip URL extraction/download and enter preparation directly.
4. Show every active or failed task. The media library and player expose processed output only; source files remain private staging data rather than playable original entries in the new flow.
5. Fetch processed bytes only following Play, Download, or Share. Completion/push/history refresh must not trigger a result download. Share downloads if needed, then opens the native share sheet with an audio file.
6. Preserve the original source title or imported filename stem. Support user rename. Use the display name in cards, detail, player, notification, export, and sharing. Keep the source title separately; never replace the name with a job ID.
7. Support user deletion, with the explicit terminal-job deletion behavior below.
8. Support cancellation at every active stage. Show Cancelling… until local work has stopped and, when a server job exists, the backend acknowledges a terminal state.
9. Retry temporary network failures a bounded number of times, then show Retry. Invalid media and terminal processing errors need an explanation and an explicit user retry/action.
10. Transfers may use any available network; no Wi-Fi-only setting or extra cellular confirmation.
11. Evolve the current visual design with stronger typography, waveform motion, gentle status-text transitions, and light/dark support.
12. Progress notifications are silent. Preserve the earlier recommended normal completion/failure notifications using existing system preferences; this is the planning interpretation of the user's answer specifying silent progress only.
13. Use compact task cards. A tap opens a full step timeline, timing breakdown, copyable job ID, and error/retry details.

## Interaction and state model

URL paste is an explicit input event: validate and commit the entire pasted value immediately. For manually typed URLs, commit a valid supported URL on keyboard Done or focus exit; do not launch jobs for partially typed video identifiers. Recomposition, restored fields, metadata updates, and returning to a screen never resubmit. Clear the accepted entry, keep keyboard/paste access available for the next input, and show the newly created card immediately.

Create and persist a UUID client operation ID before extraction or file copying. Reuse it as the existing create-job requestId for the first submission; it is the copyable Reference before a backend job exists. Once reserved, expose the full canonical backend Job ID and link both IDs in diagnostics. Intentional resubmission creates a new operation; recovery always retains the previous identity. Failed-job retries use the existing retry API and preserve retry lineage.

| Source of truth                | Internal phase/status                               | User-facing text                                |
| ------------------------------ | --------------------------------------------------- | ----------------------------------------------- |
| Mobile                         | resolving URL                                       | Finding audio                                   |
| Mobile                         | downloading source                                  | Downloading audio                               |
| Mobile                         | copying/validating import or downloaded source      | Preparing audio                                 |
| Mobile + backend               | reservation, awaiting_upload, uploading, confirming | Uploading audio / Checking upload               |
| Backend                        | queued                                              | Waiting to process                              |
| Backend                        | validating                                          | Checking audio                                  |
| Backend                        | processing                                          | Removing music                                  |
| Backend                        | uploading_result                                    | Preparing your audio                            |
| Backend                        | ready                                               | Ready                                           |
| Mobile, only after user action | fetching output                                     | Downloading your audio                          |
| Mobile/backend                 | retry wait, interrupted, processing unavailable     | Reconnecting / Waiting for processing to resume |
| Mobile/backend                 | cancel requested                                    | Cancelling…                                     |
| Mobile/backend                 | failed, cancelled                                   | Could not complete / Cancelled                  |

Display measured byte progress for transfers. Use indeterminate progress for extraction, validation, queue waiting, and separation. Do not invent a percentage, queue position, countdown, or ETA. Offline/recovery is not a terminal processing failure. A failed result download does not change the backend Ready status. Unknown server states show a safe read-only card with Refresh.

Merge local operations and cloud jobs into one row using requestId/job ID, including lost create-response recovery. Multiple operations have independent cancellation, retry counters, names, and transfer handles. Use bounded local transfer concurrency (initially two pipelines per account), without limiting how many submissions the user can add. A source waiting locally says Waiting to upload/download, not Waiting to process.

## Identity, metadata, and timing contract

The following are planned additions, not currently implemented endpoints. Backend task B01 establishes shared fixtures before either mobile client integrates them. Existing route prefixes and response envelopes stay unchanged.

- Extend POST /jobs with optional metadata: sourceTitle (trimmed, 1–200 characters), sourceKind (url or file), and clientStartedAt (ISO UTC date). requestId remains the client operation ID. Do not send source URLs or signed transfer URLs in this metadata.
- Return sourceTitle and displayName as nullable strings for legacy jobs; requestId for reconciliation; and timing with processingElapsedMs (nullable nonnegative integer), processingElapsedApproximate (boolean), totalElapsedMs (nullable nonnegative integer), totalElapsedApproximate (boolean). Also return serverTime and available stage timestamps so clients can anchor active timers.
- Rename using PATCH /jobs/:id with displayName (trimmed, 1–200 characters). Preserve sourceTitle and storage object keys. Treat rename as metadata, not a new processing request. Retry descendants inherit the latest display name.
- Server timing records retained entry/exit of the actual processing stage. Sum non-overlapping processing intervals within this job; do not include time spent offline or in validation/upload. Set `processingElapsedApproximate` when interruption forces the endpoint to use the last trustworthy observation instead of an exact processing exit.
- Local total elapsed time starts when the input is accepted and stops when Ready is observed. Persist enough timing state to recover across relaunch and clock changes. For other devices, backend totalElapsedMs is an approximate clientStartedAt-to-finishedAt interval: flag it approximate and return null for implausible/future input times. Client dates never govern queue order, quotas, leases, or authentication.
- Distinguish the audio's playback duration from processing time. Show Total elapsed and Removing music time separately. Use an em dash/unavailable label for legacy missing timings, never a fabricated zero. Output fetching time is separate and never extends the completed processing timer.

## Errors, retry, and cancellation

Add authenticated POST /client-errors for failures before and after job creation. Fields: eventId UUID, operationId UUID, optional jobId, stage, code, retryable boolean, platform (android/ios), appVersion, osVersion, occurredAt ISO UTC, and optional numeric HTTP status. Use bounded enums for stage/code with UNKNOWN fallback. Return accepted eventId; replay is idempotent per authenticated owner/eventId. An attached job must belong to that owner. The server records receivedAt separately. No raw exception text, headers, access tokens, signed URLs, source URLs, audio bytes, or local file paths.

Mobile stores a bounded UID-scoped diagnostic outbox, sends when a session/network is available, and retries reports independently of media jobs. Suggested initial bound: 100 events per account, dropping oldest delivered/noncritical duplicates before unsent terminal errors; deduplicate repeated identical stage failures. Reporting failure never blocks the user's media task. User cancellation, share-sheet dismissal, and notification denial are not error events. Backend rate limiting must cap client reports without affecting job APIs.

Use three retries after the initial transient network failure, with persisted exponential backoff and jitter; stop counters while waiting for connectivity, and do not reset them on relaunch. Follow Retry-After where present. Refresh an expired signed grant rather than treating it as bad media. Ambiguous create/upload-complete/cancel/retry responses reconcile the existing logical operation before repeating a mutation. Invalid media/auth denial are not unbounded retry candidates. Explicit failed-job Retry follows the existing new-job behavior and queue order.

Before server reservation, cancellation stops extraction, copying, and transfers, and prevents submission even if a late callback fires. If reservation may already have succeeded, reconcile requestId before claiming cancellation complete. For server work, request cancellation and refresh until acknowledged; a completion race may yield Ready and must not be falsely displayed as Cancelled.

## Rename, delete, playback, and sharing

Rename works on active and terminal tasks. Pre-job rename is stored locally and applied to the reserved job before presenting its final metadata; later metadata extraction must not overwrite a user name. Enforce the same title limits on both platforms. Sanitize exported filenames without changing the displayed title; retain the actual .mp3 extension. Duplicate display names are allowed because IDs provide identity.

Delete is a deliberate item-menu action with an in-app confirmation explaining that it removes this audio from the account and app storage, while copies exported/shared to other apps remain outside the app's control. Active tasks offer Cancel; deletion becomes available after terminal acknowledgement. Terminal states eligible for delete are ready, failed, and cancelled. Local failures without a job can be deleted immediately after local work stops.

Planned DELETE /jobs/:id returns 204 after an owner-scoped, idempotent logical deletion; active jobs return 409 JOB_ACTIVE. Hide tombstoned jobs from normal history, block new artifact grants/retries/rename, and retain minimal diagnostic/job-ID linkage for debugging. Reconcile tombstones across devices so cached rows/results disappear after refresh. Remove private input/output/cache files for that job; never delete the imported source file or another application's export. Backend media cleanup must be durable and retryable, scoped to the exact stored S3 keys/version IDs; do not introduce a Redis queue. Already issued download grants can remain usable until expiry unless the referenced object version is removed; deletion must not promise instantaneous revocation of an externally shared copy.

Ready cards have Play plus Download and Share actions; no autoplay on completion. Reuse one verified UID/job-scoped result cache and in-flight download per job across all three actions. Verify actual artifact identity before playback/share. A rename changes export/share names without re-downloading. Stop private playback and fence callbacks at logout/account change or deletion. Avoid exposing signed URLs through native sharing.

## Visual and accessibility requirements

Keep the existing brand palette and native navigation; update shared app-level tokens rather than hardcoding independent screens. Home combines URL input, Import audio, active task cards, and a processed library. Preserve old originals on disk during migration; exclude them from the new processed library rather than deleting them silently.

Use a small decorative waveform beside active steps and 150–250 ms text crossfades. Label the actual operation in text; motion does not imply a real audio waveform or measured percent. Stop animation for Ready/failed/cancelled/offscreen items. Honor reduced motion, VoiceOver/TalkBack, large text, contrast, English/Arabic and RTL. Throttle spoken announcements to phase changes, not elapsed-second or byte updates. Use existing playback waveform support if available; generating real waveform samples is not a dependency of this iteration.

## Platform background boundaries

Android: reuse/extend existing WorkManager foreground download/upload tasks and their foreground service path; avoid two competing schedulers. Show silent ongoing grouped notifications with per-job name, stage, progress, and cancellation/deep-link actions. Do not keep a transfer foreground service alive after a transfer ends. Use current push/foreground refresh and permitted scheduled refresh; background progress may be delayed and must not be presented as live when stale. Support any connected network, notification denial, timeout recovery, process death, and app relaunch. A user force-stop cannot be bypassed.

Android 14 permits swiping away many ongoing notifications on unlocked devices. Request ongoing behavior where supported, but do not use fake media playback/call notifications or repost loops to make transfer progress literally impossible to dismiss. Foreground data-sync work also has platform time limits. Sources checked on 2026-09-10: [ongoing notifications](https://developer.android.com/about/versions/14/behavior-changes-all#non-dismissable-notifications), [foreground-service timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout).

iOS: use background URLSession file transfers and existing app-delegate restoration. URL extraction/local preparation may need foreground execution and must persist a recoverable state before suspension. After the OS delivers a completed-download event, continue preparation/submission within permitted execution time, persisting the next step before the callback finishes. Do not promise arbitrary execution while suspended. Explicit user force-quit cancels URLSession background transfers; recover on the next launch without duplicate jobs. Server processing continues independently once queued. Sources: [background sessions](<https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background(withidentifier:)>), [background downloads](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background).

## Validation and delivery boundaries

- Keep existing API compatibility: additive fields and old history remain readable. New create/retry requests may return the canonical unavailable response.
- Unit tests, static checks, and builds are allowed during future implementation. No runtime proof is claimed by these plans.
- Device/UI tests may run only on iPhone 17 Pro, iOS 26.0, UDID $IOS_SIMULATOR_UDID. If unavailable, report the blocker; no substitute simulator/runtime/device.
- Android device/UI tests require separate explicit authorization of an Android target. Do not run an Android emulator or phone under the present simulator-only instruction. Android unit tests/lint/build remain available.
- No commit, push, publish, deploy, real-data deletion, or infrastructure mutation is authorized by planning. Future release/deployment remains a separate user action.
- The user reports the current live full loop works. New features require fresh validation; this is not evidence that these planned features exist.
