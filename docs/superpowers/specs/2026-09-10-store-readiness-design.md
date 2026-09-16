# Account deletion and owned-audio store release design

Status: locally implemented after user authorization, 2026-09-10. See the [implementation and validation record](../../validation/2026-09-10-store-readiness.md). Deployment and store submission remain unapproved; operational publication details remain unresolved.

## Objective and decisions

Make importing audio that the user owns or has permission to process the main MusicMute experience, and provide complete account deletion inside the apps and through a public web resource. These changes address specific policy risks; they do not guarantee store approval.

Confirmed product scope: Android and iOS account deletion, shared backend cleanup, a public deletion page, and an import-first experience on both apps. The user explicitly chose to keep YouTube as a secondary feature. This retains the downloader-related policy risk; no removal or distribution-flavor work is authorized by this plan.

Options considered:

1. Import-first apps with no YouTube downloader in the Play artifact. This offers a stronger reduction of downloader risk, but the user did not select it.
2. **Selected:** import-first while keeping YouTube secondary, native deletion plus a public support-assisted deletion path. Reuses current architecture, but the downloading feature and associated rights risk remain.
3. Recommended mobile scope plus a fully authenticated self-service deletion website. Better automation, but requires a new web authentication surface, provider configuration and more security testing. Defer unless requested.

## Source evidence before implementation

- Both apps already import files: Android `ui/VocalApp.kt`, `state/ProcessingViewModel.kt`, `processing/AudioInputPreparer.kt`; iOS `UI/HomeView.swift`, `UI/ProcessingRootView.swift`, `State/ProcessingModel.swift`, `Processing/AudioInputPreparer.swift`.
- Import currently accepts selected compressed audio containers, with an exclusive 30,000,000-byte ceiling. Do not advertise WAV/FLAC support without a separate verified pipeline change.
- Android `ui/auth/AccountScreen.kt` and iOS `UI/Auth/AccountView.swift` have no account deletion control. Session models already support reauthentication and logout cleanup.
- Backend `users/user.schema.ts` has active/disabled status; `auth/auth.guard.ts` checks status and session cutoff. There is no account deletion endpoint.
- `jobs/job-deletion.service.ts` handles terminal-job deletion, bounded cleanup leases, versioned S3 deletion and outstanding-grant grace periods. Active jobs need cancellation before this path can finish.
- `processing/processing-maintenance.service.ts` is gated by audio-processing enablement. Account deletion must continue when processing is disabled.
- Only `backend/package.json` was found as an application package manifest outside generated/dependency trees; no maintained web app was found. Do not invent an existing website integration.
- The checkout already contains substantial unrelated changes. Reinspect state before implementation and preserve them.

All source paths above are relative to `android/app/src/main/java/com/hatem/musicmute/`, `ios/Vocal/`, or `backend/src/` as indicated.

## Account deletion design

Settings → Account → Delete account → explanation → provider reauthentication → final destructive confirmation. Explain removal of account/profile, cloud inputs/results/history, device/push records, and private local copies. Original files selected from Files/document providers and user-exported copies remain under user control.

The backend owns deletion. A recent-authenticated, idempotent request first writes a durable deletion marker that blocks provisioning, job creation, new signed grants, device registration and profile writes. Deletion remains reachable despite email-verification or processing-access restrictions. A disabled account needs a verified support route.

After acceptance: revoke sessions, disable the Firebase identity, stop account work, cancel queued/active jobs, remove notifications and push registrations, sweep S3 object versions after all existing grants expire, purge account-linked MongoDB records, then delete the Firebase identity. Do not remove the account marker early and permit automatic reprovisioning from stale tokens. Mark completion only after all owned cleanup succeeds; retries and restart recovery must be durable.

The new lifecycle is control-plane cleanup integrated into the API process, not a Redis job queue. Use bounded, replica-safe leased batches. It must run independently of processing availability.

Maintain only the minimum restricted deletion receipt needed for recovery and verification. Document a finite retention period before release. Logs, database backups and provider retention need an explicit inventory and expiry policy; do not claim instant erasure from backups. A restore procedure must replay deletion requests before exposing restored data.

Already-issued signed S3 grants cannot be assumed revoked by a database flag. Stop new grants, fence uploads/completions and wait for maximum outstanding grant validity plus the existing safety window before the final sweep.

Public `/delete-account` page: clearly identify MusicMute and the developer, explain scope/timeframes, and offer an actionable support-email request without reinstalling the app. The public page does not delete accounts merely from a supplied email address. Support verifies ownership and uses the same durable backend lifecycle through an authenticated operator procedure. No passwords or ID tokens are requested by email. A monitored inbox and verified ownership procedure are release prerequisites.

## Owned-audio experience

Home leads with “Import audio”, followed by “Choose an audio file you own or have permission to process.” Before upload, show selected filename, validated duration/size, output intent (“Create vocals-only audio”), cloud-processing disclosure, rights confirmation, and an explicit “Remove music” action. Selecting a file must not upload it immediately. A cancelled picker or confirmation creates no cloud job.

Reuse existing preparation, account-scoped staging, FIFO processing, cancellation/retry, private S3 and vocals-only MP3 output. Playback still starts only after a tap. Preserve library/history and user exports. No new recording, public sharing, billing, formats, or offline separator work is included.

Keep YouTube URL entry accessible as a clearly labelled secondary action on both apps. Do not conceal it from reviewers, gate it on review status, remove its dependencies, or create separate flavors. Apply rights guidance and truthful source attribution to this flow too. Require an explicit action before downloading and a separate, clearly disclosed confirmation before cloud processing; audit every existing automatic download-to-upload handoff. Preserve existing saved media and history. Rights confirmation cannot prove permission or resolve a prohibited downloading use case.

Keep foreground-service types needed by real transfers and playback. Review the release manifest and library behavior. Update listing copy/screenshots to demonstrate owned/licensed files, and accurately disclose the retained YouTube feature rather than presenting the app as local-import-only. Rights confirmation is user guidance, not proof of ownership or a substitute for removing risky functionality.

## Open product questions

1. **Answered:** keep YouTube secondary, including the Play version.
2. **Answered:** both Android and iOS plus shared backend and website.
3. Which public domain, developer display name and monitored support email should privacy/deletion pages use? No production URL or contact has been invented.
4. Proposed service goal: disable access immediately on acceptance and normally finish live-data deletion within 7 days. Confirm the supported deadline and any legitimate retention obligations; publish only measured, supported commitments. Backup expiry requires infrastructure verification.

## Global constraints

- Work in the current repository; preserve unrelated edits, secrets and generated files.
- No commits, pushes, publishing, deployments or real-user deletion without explicit authorization.
- Reuse Kotlin/Compose, Swift/SwiftUI, NestJS, Firebase Auth, MongoDB, external Redis and private S3.
- Keep the API-only runtime; no new processing queue is introduced by store-readiness work.
- UI/device tests only on existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`. Android device/UI validation is blocked under this restriction unless explicitly changed. Android static/unit/build checks remain allowed.
- Preserve vocals-only MP3 output and explicit-tap playback.
- Verify primary policy sources again at implementation/release time.

## Policy basis checked 2026-09-10

- [Google account deletion](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en): in-app and external request paths, associated-data deletion and transparent retention.
- [Google User Data](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en): accurate privacy and data-handling disclosures.
- [Google Intellectual Property](https://support.google.com/googleplay/android-developer/answer/9888072?hl=en): prohibits infringement and encouraging unauthorized downloads.

## Delivery order

Implement the account-deletion backend first, then app controls and the public request resource. Implement the owned-audio release independently against the existing processing API. Finish with disposable-account deletion proof, release-artifact inspection, verified public links and matching store disclosures. Deployment and submission are separate authorized actions.
