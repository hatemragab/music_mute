# Mobile audio processing design

Date: 2026-09-09. Status: recommendations approved; implementation not started.

## Approved experience
- Accept completed on-device YouTube downloads and audio selected through the system file picker.
- The user explicitly taps **Remove music**. Downloading original audio never submits a processing job automatically.
- Produce voice-only MP3. Download a result only when the user taps Download, Play, or Save; reuse a valid cached result thereafter.
- Preserve original playback/export. Replace the simulated separation entry point with real processing.
- Keep English/Arabic, RTL, theme, accessibility, and native platform patterns.

## Authority and current source
The implemented [API](../../../backend/docs/api/audio-processing.md), [backend design](../../../backend/docs/superpowers/specs/2026-09-09-audio-processing.md), and [operations requirements](../../../backend/docs/operations/audio-processing.md) are authoritative. Mobile clients never call worker routes, possess worker secrets/AWS credentials, or download YouTube URLs on the server.

Android currently uses Kotlin/Compose, StateFlow, constructor injection, DataStore, WorkManager, and Media3 under android/app/src/main/java/com/hatem/musicmute. iOS uses SwiftUI, observable models, actor-backed JSON storage, URLSession, and AVAudioPlayer under ios/Vocal. Both have mandatory Firebase/backend session bootstrap. Both currently expose demo separation. Their existing original-download histories are installation-local and shared across sign-ins; preserve these histories.

## Input and upload
Supported declaration pairs: m4a/mp4 → audio/mp4; webm → audio/webm; opus/ogg → audio/ogg; aac → audio/aac; mp3 → audio/mpeg. Select audio-only files. Reject unsupported, empty, unreadable, video-bearing, undecodable, unknown-duration or oversized files before creating a reservation. Do not transcode or silently rename an unsupported format. Platform decoders can reject a format they cannot inspect; explain that limitation.

Input bytes must be 1..29,999,999 and duration finite, >0 and <600 seconds. Compute canonical padded base64 SHA-256 over the immutable staged bytes, not a hex digest or provider metadata. Obtain actual duration; preserve iOS's existing audio-frame duration handling for fragmented M4A. Copy selected files into app-owned staging with bounded streaming; cloud-provider access, revoked permissions, storage exhaustion and selection cancellation need explicit outcomes.

Persist UID, local operation ID, UUIDv4 requestId, exact declaration and staged path before POST /jobs. Retry the same logical request with the same ID/body. Upload with multipart/form-data to the returned HTTPS grant URL; preserve every signed field and append the file last. Never attach Firebase Authorization, installation headers or cookies to S3. Do not retain signed URLs as identity or log them.

After upload success, POST upload-complete; only successful server confirmation enters FIFO. If a response is lost, refresh job state and retry confirmation before sending bytes again. If bytes are needed, renew the grant only while awaiting_upload. Signed POSTs are whole-file transfers; do not promise resumable multipart ranges. Bounded retries reuse the same reservation. Surface an explicit resume action after exhaustion/relaunch where automatic recovery is unavailable.

## Cloud state and privacy
Server history is authoritative and scoped to the authenticated owner. Store new job metadata/staging/result caches under UID-specific paths excluded from backup. Every asynchronous callback carries a session epoch and UID; account changes fence old callbacks, cancel owned client network work and clear visible cloud state. Logging out does not cancel server processing. Retain private files without automatic deletion; make them inaccessible through another account's UI. Existing shared original downloads remain unchanged, and independently exported copies remain user-managed.

Support all statuses: awaiting_upload, queued, validating, processing, uploading_result, interrupted, cancel_requested, ready, failed, cancelled. Local preparation/upload/result-download phases are separate from server status. Show byte progress for actual transfers and indeterminate separation stages; there is no server percent, queue position, ETA or list-level workerAvailable. Detail has workerAvailable; false means the worker is unavailable, not a failed job. interrupted can recover on the same job when the personal Z440 returns.

Foreground history/detail refresh uses one cancellable loop, roughly 10 seconds while active work is visible, exponential backoff capped at 60 seconds on transient errors, and refresh on foreground/manual action/push. Stop polling offscreen/background. Merge by job ID, discard old request generations and replace pagination on full refresh. Treat cursors as opaque. Unknown statuses show safe read-only state and permit refresh.

## Actions and errors
Cancel calls the API. Keep cancel_requested visible until server acknowledgement; never invent cancelled on a timeout. A ready/cancel race is resolved by refetching. Cancelling local upload first fences/stops the local operation, then cancels any reservation; if creation was in flight resolve its persisted requestId before cancelling it.

Retry applies to failed jobs and creates a new requestId/new job at the FIFO tail. Persist retry intent before network calls. NEW_INPUT_REQUIRED leads to choosing a replacement file; never repeatedly retry invalid bytes. interrupted is recovery-in-progress, not an invitation to create a duplicate retry. For uncertain actions, refetch before offering another operation.

Use API code-based localized messages, including 401 reauthentication/one safe token refresh, 403 policy restrictions, 404 unavailable owner job, 409 state refresh/idempotency conflict, 429 Retry-After and sanitized 503. Do not erase existing jobs on service unavailability. Do not display process diagnostics.

## Results
Request output download-url only for a ready job, fetch to a private partial file, validate a nonempty playable MP3, and atomically promote to a UID/job-specific cache. The safe API projection does not expose output digest/length, so do not claim server checksum comparison. Interrupted/cancelled downloads cannot overwrite a completed file. Renew an expired URL after authentication/state refresh with bounded retry; do not retry every 403 blindly. Reuse existing player and native export mechanisms. A missing/invalid cache triggers a fresh authorized fetch; no automatic bulk download or cleanup.

## Notifications and prerequisite
Register current FCM token using PUT /devices/:installationId/push only after successful device/session sync. Retain its bindingRevision and send expectedBindingRevision to POST /devices/:installationId/push/deactivate so stale cleanup cannot disable a newer registration. Handle token rotation, denied permission, account switches, foreground/resume retry and bounded best-effort authenticated deactivate before local sign-out. Sign-out must succeed if offline. Pending deactivation must never be replayed under a different user's credentials or a newer authentication epoch for the same user. This backward-compatible API addition is recorded as MOB-B02 in the execution tracker.

The backend data keys are type=audio_job_outcome, jobId, eventId, outcome. Event IDs use the opaque format notification:<outbox-id>:<registration-id>:<binding-revision>. Treat the payload as an untrusted refresh hint; deduplicate eventId and authenticate/fetch the job before opening details or showing job-specific content. Never switch accounts based on a push. Offline hints can wait until authenticated refresh.

**MOB-B01 prerequisite:** platform-visible FCM/APNs notifications now use generic privacy-safe text, APNs alert headers/payload and the Android processing channel. Existing data keys and durable outbox behavior are preserved; foreground handling refreshes state without duplicating the system alert. Payload and isolated dispatch tests pass. APNs signing/Firebase configuration, terminated-app behavior and real delivery still require separate validation; no automatic infrastructure edits are authorized here. Foreground refresh works even if push is denied, delayed or unavailable.

## Validation and scope
Originally approved as a documentation-only plan. Implementation was subsequently authorized on 2026-09-10; see the execution tracker for current local proof and remaining external validation. No deployment, commit or push is authorized.
During implementation use focused tests and production builds. Device/UI tests are authorized only on the existing iPhone 17 Pro iOS 26.0 simulator, UDID $IOS_SIMULATOR_UDID. Android cannot run on that simulator: JVM/lint/build checks proceed, Android device/UI proof remains blocked unless the user explicitly changes the target restriction. This supersedes older README device instructions.
Use isolated emulator-auth/backend/storage fixtures for functional integration; do not create real accounts without approval. Simulator notification injection proves client handling, not live FCM/APNs. Real S3, deployed backend and Z440 separation need their own end-to-end proof.

## Delivery
Separate Android and iOS plans implement this same contract. Each task has a focused test cycle and review. All tasks start unchecked. See [task tracker](../../tasks/mobile-audio-processing.md).
