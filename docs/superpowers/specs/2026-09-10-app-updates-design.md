# MusicMute release dashboard and app updates design

> Dashboard execution is owned by the [full dashboard task package](../../tasks/full-dashboard/README.md). Its approved stack is React + TypeScript + Vite, Tailwind CSS + shadcn/ui, React Router, TanStack Query and Firebase Web Authentication. The full package supersedes the older dashboard source map, minimal UI scope, equal-access authorization and hosting steps below. Hosting is excluded; implementation remains paused until the user requests resumption and B18 passes.

Date: 2026-09-10. Status: requirements captured; implementation not started.

## Confirmed decisions

- Build a MusicMute web dashboard; do not treat CapRover as the release dashboard.
- Google sign-in; backend-enforced administrator allowlist. Initially one owner account, expandable later. The owner supplied the initial email in the planning conversation; configure it privately at execution time, not in source or public documentation.
- Upload signed Android APK files through the dashboard into private S3 storage. Users obtain temporary S3 download links from the backend.
- Use **azhon/AppUpdate** for the direct Android APK download/installation integration.
- Android update destination is configurable: direct APK initially, Google Play when the app is published there.
- Support optional and forced updates independently for Android and iOS. Forced update blocks the **entire mobile app**, including playback, local files, navigation and notification/deep-link entry points. It does not delete audio or sign the user out.
- Release changelogs are **English only**. Existing English/Arabic interface localization remains; changelog content is English in either locale.
- With no previously known forced requirement, the app opens normally offline, subject to its existing authentication/offline-session behavior. This feature does not create offline sign-in.
- Check at launch; every **15 minutes** while foregrounded and online; immediately on internet reconnection; on foreground entry if the last check is at least 15 minutes old. No background policy polling.
- Optional update reminders repeat **24 hours after Later**.
- Backend rejects media-processing submissions from builds below the platform minimum. Already-submitted server jobs continue; results remain available after updating.
- Planning is authorized. Implementation, commits, pushes, publishing releases, deployment, and production mutations are not authorized by this document.

## Implementation defaults for review

These resolve details not separately chosen in conversation; they are not additional claims of user approval.

- Upload creates a draft. Only an explicit publish action changes mobile behavior.
- Persist the last valid policy independently of login. A **known** forced requirement remains blocking offline; a network error cannot clear it. A newer valid policy can withdraw it. The user's offline answer was given for the case where no forced requirement was known.
- Optional Later suppression is installation-wide for 24 hours, including another optional release during that window. Mandatory updates always override suppression. Returning from an installer without updating does not unlock the app.
- One platform-wide minimum supported build remains the backend enforcement authority. Direct and Play channels can have different latest releases, but each activated channel must provide a compatible target at or above that minimum.
- Pausing local playback/transfers is distinct from cancelling a cloud job. Incomplete local inputs remain recoverable; submitted cloud jobs are never cancelled by update gating.
- Dashboard MVP language: English. Admin accounts are an allowlist, not a new role hierarchy. All approved admins can manage releases and allowlist entries; the last administrator cannot be removed.
- Dashboard: React, TypeScript, Vite, Firebase Web Authentication and native fetch. Serve its production files at `/admin/` from the existing backend deployment. This introduces a small web build, not a separate SSR server. No existing dashboard exists to reuse.
- Direct and Google Play Android product flavors share the application ID and data schema. The Play artifact excludes APK-installer code and `REQUEST_INSTALL_PACKAGES`; runtime settings cannot enable them in that artifact.
- Initial APK limit: 256 MiB. Upload grants: 15 minutes. Download grants: 60 minutes, refreshable after expiration. Verification has a 90-second server deadline and a 120-second dashboard request deadline; reverse-proxy behavior must be validated separately.
- Use the existing S3 bucket under a dedicated `app-releases/` prefix, with immutable object version identities. Reuse S3 client/privacy/versioning infrastructure, not media-job ownership or cleanup logic. No lifecycle or public-access changes occur automatically.
- Withdrawal creates a newer policy revision. It never downgrades an installed APK, erases files, or silently deletes release objects.

## Existing source and integration boundaries

| Concern                | Current files                                                                                                                  | Consequence                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy policy          | `backend/src/app-policy/{app-policy.schema,access-policy,app-policy.service,app-policy.presenter}.ts`                          | Preserve `minimumBuild`, `latestBuild`, `downloadUrl`, email policy and revision semantics. Current validation rejects unknown stored fields; update it deliberately. |
| Enforcement            | `backend/src/app-policy/processing-access.guard.ts`, `backend/src/jobs/jobs.controller.ts`                                     | Creation, retry, upload renewal and upload confirmation already have processing guards. Existing history and results stay independently readable.                     |
| Operator policy writes | `backend/src/operations/policy-command.ts`                                                                                     | Once release management is enabled, prevent this CLI from bypassing release validation for version fields; keep email-policy operations working.                      |
| Authentication         | `backend/src/auth/{auth.guard,firebase-identity.service,firebase.module}.ts`                                                   | Reuse Firebase revocation/disabled-account checks. Dashboard login must not require a mobile installation bootstrap.                                                  |
| Storage                | `backend/src/infrastructure/storage.module.ts`, `backend/src/storage/{storage-preflight.service,storage-transfers.service}.ts` | Private, versioned S3 primitives exist. Keep release objects outside media retention/cleanup.                                                                         |
| Android                | `android/app/src/main/java/com/hatem/musicmute/auth/`, `ui/auth/AccountScreen.kt`                                              | Policy is currently acquired through auth; the update coordinator must work before login. `latestBuild` currently produces no prompt.                                 |
| iOS                    | `ios/Vocal/Auth/`, `ios/Vocal/UI/Auth/AccountView.swift`                                                                       | Same gap; create a root-level update gate outside authentication.                                                                                                     |
| Lifecycle              | Android `VocalApplication.kt`, `MainActivity.kt`; iOS `VocalApp.swift`                                                         | Foreground handling exists but does not consistently refresh policy. Add a dedicated coordinator without duplicate timers.                                            |
| Transfers              | Both `ProcessingRepository` implementations                                                                                    | Reuse local-transfer stopping semantics, not cancellation/sign-out cleanup.                                                                                           |
| Deployment             | `backend/Dockerfile`, `backend/scripts/package-caprover.mjs`                                                                   | Current image is Alpine and packages only backend source. APK verification tools and dashboard assets need explicit packaging tasks.                                  |

Reinspect these files before implementation: other work in this checkout is active. Preserve all pre-existing tracked/untracked modifications and deletions.

## Public contract

All paths below are relative to `/api/v1`. IDs are server-issued opaque strings. Integer builds are in `1..2147483647`; never compare marketing versions lexically.

```ts
type Platform = "android" | "ios";
type Distribution = "direct" | "play" | "app_store";
type UpdateSource = "direct_apk" | "google_play" | "app_store";
type ArtifactState = "awaiting_upload" | "verifying" | "verified" | "rejected";
type ReleaseState = "draft" | "published" | "withdrawn";

interface ReleaseTarget {
  id: string;
  versionName: string;
  buildNumber: number;
  changelogEn: string;
  source: UpdateSource;
  storeUrl: string | null;
  artifact: null | {
    bytes: number;
    sha256Hex: string;
    signerSha256Hex: string;
  };
}
interface UpdatePolicySnapshot {
  schemaVersion: 1;
  revision: number;
  platform: Platform;
  distribution: Distribution;
  minimumBuild: number | null;
  target: ReleaseTarget | null;
  checkedAt: string; // server ISO timestamp; never a secret URL
}
interface ReleaseDownloadGrant {
  releaseId: string;
  url: string;
  expiresAt: string;
  bytes: number;
  sha256Hex: string;
  signerSha256Hex: string;
}
type UpdateDecision = "none" | "optional" | "required";
```

- `GET /app-updates/policy?platform=android&distribution=direct`: public, rate-limited, `Cache-Control: no-store`; no Firebase account needed. iOS accepts only `app_store`; Android accepts `direct` or `play`. Invalid combinations return 400.
- Direct distribution follows the dashboard Android source setting. Play distribution always receives a Google Play target. An incompatible configuration cannot be published.
- `POST /app-updates/releases/:id/download`: public, rate-limited, empty body; issue a fresh grant only for an active, published, verified direct-APK release. Never accept a bucket/key/URL from the caller. No Firebase bearer is forwarded to S3.
- Existing `/app-policy`, auth session, and profile-sync responses preserve their legacy policy shape. Keep presigned URLs out of policy documents and legacy `downloadUrl`; use a stable, public release landing URL for APK updates.
- `APP_UPDATES_ENABLED=false` preserves the existing API behavior during staged deployment. With the feature enabled, an absent rich policy is allowed only if legacy version restrictions are empty; otherwise return service-unavailable and require an explicit operator conversion. Never clear a pre-existing minimum silently.
- A policy request failure retains the previous valid snapshot. An unknown schema cannot overwrite it. A first-install fetch failure does not create a forced requirement. Backend processing authorization still runs on every guarded request.

Decision examples:

```text
installed=9, minimum=10, latest=12  -> required
installed=10, minimum=10, latest=12 -> optional
installed=12, minimum=10, latest=12 -> none
installed=13, minimum=10, latest=12 -> none
no target and no minimum           -> none
target below minimum              -> invalid policy; never publish/cache it
```

## Stored policy, release lifecycle and atomic publication

Add an optional stored `releaseSelection` to each platform in the existing `app_policies` singleton. It contains `source`, `directReleaseId`, and `storeReleaseId` (nullable where not applicable). Legacy records lacking it remain readable. The legacy presenter explicitly emits only the old fields; the new presenter expands immutable release metadata into the public snapshot.

New collections:

- `app_releases`: platform/source, version/build, English changelog, release/artifact states, immutable S3 key/version/checksum/signing metadata, creation actor and timestamps. Unique platform/source/build; published content is immutable.
- `release_uploads`: reservation ID, release ID, expected size/checksum, server-generated key, expiry, pinned S3 version, verification lease and result. The lease is only for bounded APK inspection.
- `dashboard_admins`: one revisioned allowlist document; entries bind a Firebase UID to its verified Google email, with active status. No wildcard/domain access and no automatic registration based on a client email string.
- `release_audit_events`: actor UID, action, IDs, old/new policy revision, time. No bearer tokens, signed URLs, APK bytes, user media, or credentials.

Publication transaction validates the artifact, source availability and `expectedRevision`; changes the platform release selection and legacy version projection; marks the release published; and inserts its audit event. Increment the existing policy revision once. A stale revision returns 409 with no partial write. Read the selected release and policy consistently; published release contents never change.

When Play and direct channels are both active, publication must preserve a usable target for both. The dashboard shows the common platform minimum and separate channel targets. A lower minimum is an explicit audited withdrawal/recovery action; `latestBuild` and the download destination are updated together.

## Dashboard API and authentication

Google tokens must be verified server-side with revoked/disabled checks, verified email, and `google.com` sign-in provider. Reuse `FirebaseModule`. Use protected admin-route metadata plus an admin guard; do not mark admin writes public or require mobile profile/device bootstrap. Check allowlist membership on every request. A removed administrator loses API access even with a still-valid token.

Bootstrap the initial allowlist through an explicit operations command that resolves the privately configured email to an existing verified Google Firebase account. Dry-run shows only redacted identity and the intended change; apply requires explicit operational authorization. Do not commit the supplied email or populate production during implementation.

| Endpoint                                             | Purpose                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/session`                                 | Verify dashboard admission and return the current admin identity.                                                                                                   |
| `GET /admin/releases?platform=&cursor=`              | Bounded paginated release history.                                                                                                                                  |
| `POST /admin/releases`                               | Create Android or iOS draft; no publication side effects.                                                                                                           |
| `PATCH /admin/releases/:id`                          | Edit draft metadata with expected draft revision.                                                                                                                   |
| `POST /admin/releases/:id/uploads`                   | Reserve APK upload: `{bytes, sha256Hex}`; return POST URL, exact fields and expiry.                                                                                 |
| `POST /admin/releases/:id/uploads/:uploadId/confirm` | Pin and verify the uploaded object; idempotent success, 409 in-progress, bounded errors.                                                                            |
| `POST /admin/releases/:id/preview`                   | Validate a proposed minimum/source/revision; report affected installation counts and warnings without writes.                                                       |
| `POST /admin/releases/:id/publish`                   | Apply the previewed `{minimumBuild, source, expectedRevision, availabilityConfirmed}` atomically.                                                                   |
| `POST /admin/releases/:id/withdraw`                  | Explicit `{replacementReleaseId, minimumBuild, expectedRevision}` recovery; null replacement allowed only with null minimum and disabled prompts for that platform. |
| `GET /admin/accounts`                                | Read current allowlist and its revision.                                                                                                                            |
| `POST /admin/accounts`                               | Resolve and add an existing verified Google account by email with expected allowlist revision.                                                                      |
| `DELETE /admin/accounts/:uid`                        | Remove access with expected revision; reject removing the last active administrator.                                                                                |

Dashboard sends Firebase tokens in Authorization headers, never query strings. Keep tokens out of application-managed local storage/logging. Firebase persistence can use session scope. Deny unapproved Google accounts explicitly; do not expose admin data while resolving authentication.

## S3 upload and APK verification

1. Dashboard calculates size/SHA-256 in a Web Worker and requests a bounded reservation. The server sets the key and exact checksum/size conditions.
2. Browser uploads directly with a presigned POST. Keep bucket private; CORS admits only configured dashboard origins. An upload success is not a verified release.
3. Confirmation pins `VersionId`, streams that exact object into a private temporary file with an upper byte bound, and independently recomputes SHA-256.
4. Run trusted, pinned `apksigner` and `aapt2` executables using an argument array, bounded output, timeout, and no shell. Never execute APK content. Extract application ID, integer build, version name, minimum SDK, signer digest and debuggable status. Reject package mismatch, invalid signature, unapproved signer, debug APK, size/checksum mismatch or unsupported minimum SDK.
5. Initial signer allowlist is private deployment configuration, derived from the maintained release key's public certificate. An uploaded APK cannot authorize its own signer. Accept no key rotation automatically.
6. Verification is synchronous and bounded, with a per-upload CAS lease and no BullMQ dependency. Expired verification can be retried only after its deadline and against the same immutable object version. Always terminate child processes and clean temporary files on cancellation/error.
7. Only `verified` artifacts are publishable. Rejected uploads remain unpublished. Do not delete S3 objects or change retention automatically as part of this feature.
8. Download grants reference the verified `VersionId`. Refresh an expired link by release ID, never by a persisted signed URL. Partial downloads are reused only after identity checks and final whole-file verification.

## Mobile behavior and state

Shared constants: check interval `900000 ms`; optional deferral `86400000 ms`. Inject clocks in tests. Persist server policy revision, last valid snapshot, check time and optional deferral time atomically. Do not use a stored future wall-clock value to suppress checks indefinitely; detect clock rollback and make a fresh check when online.

Coalesce launch, connectivity and foreground triggers into one in-flight request. Foreground retry after failure is bounded at 30 seconds, 2 minutes, then the normal 15-minute interval; honor Retry-After. Connectivity flapping is debounced. Stop polling on background entry. Permit explicit Retry on the blocked screen within rate limits.

Root state machine: `checking`, `allowed`, `optional`, `required`, plus transport status. With a known required snapshot, render required immediately while rechecking. With no known requirement, do not permanently lock startup on an unavailable backend. Policy 403 processing responses trigger a fresh policy check and a provisional required state; failure to fetch details does not turn a known `APP_UPDATE_REQUIRED` into permission to continue.

Required UI shows current/target version, English changelog, Update, Retry, and useful download/permission errors. No Later/back/swipe escape into the app. External installer/store UI remains reachable. Dismissing installation returns to the required screen. Re-read the installed build and current policy before unlocking; clicking Update is not proof of installation.

Gate playback service/remote transport controls, share/import entry, deep links and pending notification taps, not just visible tabs. Stop local playback and pause resumable local work without firing cloud cancellation, deletion, logout, or data migration. Preserve server job IDs and account ownership. Completion notifications may arrive but cannot bypass the gate.

Android direct: custom MusicMute UI and gate; azhon/AppUpdate adapter for download/install. Disable automatic installation until SHA-256, package/build and signer checks finish. If its callback API cannot guarantee verification before install, use its custom downloader boundary and explicit install handoff; never silently skip verification or change libraries.

Android Play: official Play update API with eligibility checks, resumption and listing fallback. No direct APK fallback in Play artifacts. A forced policy is published only when the target is available to the intended users; a staged rollout alone does not establish that.

iOS: use the same policy timing, persistence, gate and English changelog. Open a validated App Store URL; no APK/IPA self-installer. The real App Store ID/availability are operational prerequisites and must not be invented.

## Validation and rollout boundaries

- Unit/contract tests cover all decisions, time boundaries, policy rollback, offline restoration, admin rejection, immutable artifact identity and source switching.
- Server integration tests prove old clients cannot submit, while claimed/submitted jobs can complete and their results survive a publication.
- Device/UI execution is restricted to **iPhone 17 Pro, iOS 26.0**, UDID **$IOS_SIMULATOR_UDID**. If absent, report the blocker. Older documents naming another device do not override this instruction.
- Android unit tests, lint, builds and APK manifest inspection may run. Android installation/permission/Google Play device tests require the user to explicitly authorize an Android device; an iOS simulator cannot establish that proof.
- Bootstrap feature release must reach mobile users before a dashboard publication can show the new UI on those devices. Older installed clients cannot acquire new UI through a backend deployment.
- Production S3/CORS/IAM, Firebase web domain, admin bootstrap, store listing, signer compatibility, deployment and real publication are separately authorized operations. Local tests/builds do not prove them.

## Research used

Reviewed 2026-09-10; verify resolved versions before implementing.

- [Selected azhon/AppUpdate](https://github.com/azhon/AppUpdate): Kotlin, Apache-2.0; README documents Maven Central version 4.3.6. Built-in MD5 handling is not a substitute for our SHA-256/signing checks.
- [Google Play update API](https://developer.android.com/guide/playcore/in-app-updates/kotlin-java).
- [Google Play self-update restriction](https://support.google.com/googleplay/android-developer/answer/9888379?hl=en).
- [Android cross-store update compatibility](https://developer.android.com/google/play/app-updates).
- [App signing versus upload signing](https://developer.android.com/studio/publish/app-signing).
- [Android package-install permission](<https://developer.android.com/reference/android/content/pm/PackageManager#canRequestPackageInstalls()>).
- [Apple app updates](https://support.apple.com/en-us/102629).
