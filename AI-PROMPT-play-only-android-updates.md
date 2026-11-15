# Task: Android updates come from Google Play only

You are implementing one MusicMute product change in `/Users/hatemragap/work_spaces/music_remover`.

Android no longer downloads or installs an APK from MusicMute. The dashboard no longer offers **Direct APK** and no longer accepts an APK upload. An operator records the Play version name and version code here, and can force older builds to update. The Play-distributed app installs that update with the Play In-App Updates API. The APK or AAB is uploaded only in Play Console.

**Do not commit, push, deploy an image, publish a release, or change production data.**

## Read before editing

- Root `AGENTS.md` and `CLAUDE.md`
- `android/README.md` section **App updates**
- `docs/google-play-release.md` section that describes the Play update policy and the 503
- `backend/AGENTS.md` before backend edits
- `dashboard/README.md` before dashboard edits
- `docs/backend-security/route-matrix.md` rows for `/app-updates/*`
- `backend/openapi.yaml` release and `/app-updates` sections that this task changes

Do not read or print dotenv values, tokens, cookies, signed URLs, or keystore material.

## Locked decisions

These are the product rules. Do not invent a second version registry, a Play Developer API client, or an APK fallback.

1. **Google Play is the only Android distribution.** iOS App Store drafts, iOS minimum build, and iOS store-URL checks stay as they are. Do not touch macOS, the Chrome extension, the web client, or `/jobs/:id/download-grants`. That job route delivers processed audio, not app updates.
2. **The dashboard does not receive the Android binary.** Delete the APK upload panel and its hash worker from the release flow. Creating an Android release sends version name, build number, English changelog, and the fixed Play listing URL. It does not send a file.
3. **Force update stays the existing minimum build.** `minimumBuild` on the Android policy is the force switch. The Play Console update priority and staleness fields are not the force switch. Do not call the Play Developer API.
4. **Play In-App Updates is the installer.** The Play flavor already depends on `com.google.android.play:app-update` and `app-update-ktx` at version `2.1.0` in `android/gradle/libs.versions.toml`. Use that library. A required update uses `AppUpdateType.IMMEDIATE`. An optional update uses `FLEXIBLE` when Play allows it, otherwise `IMMEDIATE`. If Play cannot offer a high enough build, open only the verified listing URL. Never download an APK.
5. **The dashboard decision and the Play binary are different steps.** `GET /app-updates/policy?platform=android&distribution=play` still decides `required`, `optional`, or `none` by comparing the installed version code with `minimumBuild` and the target build. Play supplies the bytes. For a required update, accept any Play-offered build greater than or equal to `minimumBuild`, even if it is below the dashboard target. For an optional update, require the Play-offered build to be greater than or equal to the dashboard target. Clear the required gate only after the installed build meets the current minimum; Play availability or user consent alone does not clear it. An installed build between the minimum and target remains eligible for an optional update without blocking use.
6. **No install-package permission.** `REQUEST_INSTALL_PACKAGES` exists only in `android/app/src/direct/AndroidManifest.xml`. Delete that manifest and do not add the permission to `src/main` or `src/play`. `android/scripts/check-play-release.py` already fails the Play bundle if that permission is present. Keep that check.
7. **Delete the direct client, keep the Play variant name.** Remove the `direct` product flavor, `src/direct`, `src/testDirect`, and `io.github.azhon:appupdate`. Keep the `play` flavor and `UPDATE_DISTRIBUTION = "play"` so the bundle path stays `android/app/build/outputs/bundle/playRelease/`. Do not collapse the flavor dimension.
8. **Historical direct releases stay in Mongo.** Do not run a migration and do not rewrite production `AppPolicy` or `Release` documents. Admin reads may still return `source: "direct_apk"`. Those rows are read-only: no upload, no publish, no selection as the Android target. New writes reject `direct_apk`.
9. **Stop APK egress and ingest.** `POST /app-updates/releases/:id/download-grants`, `POST /app-updates/releases/:id/download-redirects`, and `GET /app-updates/releases/:id` must not return a signed APK URL, a redirect to one, or the APK landing page. `GET /app-updates/policy?distribution=direct` is rejected. Admin upload routes under `/admin/releases/:id/uploads` reject new APK uploads. Leave job media grants alone.
10. **Do not fix the live Play 503 from this task.** Production Play policy can have no `storeReleaseId`. That returns 503 when a minimum is set. Do not publish a release, invent a target, or clear `minimumBuild` to silence it. An operator does that later, after the AAB is actually available on Play.

## What exists today

Android is two flavors of the same application id, `com.hatem.musicmute`.

| Flavor | `UPDATE_DISTRIBUTION` | Installer | Permission |
| --- | --- | --- | --- |
| `direct` | `direct` | `DirectUpdateInstaller` downloads an APK through azhon AppUpdate 4.3.6, verifies it, then opens the system installer | `REQUEST_INSTALL_PACKAGES` in `src/direct/AndroidManifest.xml` |
| `play` | `play` | `PlayUpdateInstaller` only fires `ACTION_VIEW` on the store URL | none |

`VocalApplication` builds both the coordinator and `createUpdateInstaller(...)`. `MainActivity` already calls `updateInstaller.onForeground()` from `onResume`, and `UpdateGate` blocks the whole UI when the decision is `REQUIRED`. Optional updates can be deferred for 24 hours. Keep that gate, the check schedule, the cache, and the admission fence.

The public snapshot is `ReleasePolicyService.snapshot()` in `backend/src/releases/release-policy.service.ts`. For `distribution=play` the target id is `storeReleaseId`, the source must be `google_play`, and `artifact` is null. `decideUpdate()` in `backend/src/releases/release-policy.ts` returns `required` when `installedBuild < minimumBuild`, `optional` when `installedBuild < target.buildNumber`, and `none` otherwise. A minimum without a target is invalid.

The dashboard Android form defaults to `direct_apk` and hides the store URL for that source. See `dashboard/src/features/releases/release-draft-form.tsx`. The policy form still has **Distribution source**, **Direct release ID**, and **Play release ID** in `update-policy-form.tsx`. `ApkUploadPanel` is mounted from `release-detail-page.tsx` and only runs when `source === "direct_apk"`. Publish already requires `storeAvailabilityConfirmed === true` for a Play or iOS release, in `ReleasePublicationService.mutate()`.

The only legal Play listing is:

`https://play.google.com/store/apps/details?id=com.hatem.musicmute`

`validateReleaseDraft()` already requires `https`, host `play.google.com`, path `/store/apps/details`, and `id` equal to `APK_EXPECTED_PACKAGE_ID`, with no other query keys. Keep that check. The package id configured for production is `com.hatem.musicmute`.

## Dashboard

Android release creation has one distribution: **Google Play**. Remove the Direct APK option from:

- `dashboard/src/features/releases/release-draft-form.tsx`
- `dashboard/src/features/releases/releases-page.tsx`
- `dashboard/src/features/releases/update-policy-form.tsx`
- `dashboard/src/features/releases/update-policy-page.tsx`

Default a new Android draft to `google_play`. Switching the platform to iOS still selects `app_store`. Switching back to Android selects `google_play`, never `direct_apk`.

The Android draft dialog no longer asks the operator to type a store URL. The client sends the fixed listing URL above. The backend still rejects any other URL. Show this helper text:

> Upload the Android App Bundle in Play Console. This form records the version name and build number Play is serving. MusicMute does not receive the file.

Version name and build number stay newer than the current Play release, using the existing proposal endpoint. Changelog and reason stay required.

Remove the upload UI and its client upload code from the release screens:

- `dashboard/src/features/releases/apk-upload-panel.tsx`
- `dashboard/src/features/releases/apk-upload.ts`
- `dashboard/src/features/releases/apk-hash.worker.ts`
- `dashboard/src/features/releases/apk-upload.test.ts`
- `dashboard/e2e/apk-upload-redirect.spec.ts`
- the `ApkUploadPanel` mount in `release-detail-page.tsx`

A historical `direct_apk` row, if the API still returns one, shows its version and a read-only **Retired direct APK** label. It has no file picker, no publish action, and it cannot be chosen as the Android target.

### Update policy form

The Android fieldset keeps **Minimum supported build** and **Play release ID**.

Remove **Distribution source** and **Direct release ID**. The Android source sent to the API is always `google_play`. `directReleaseId` is always `null`.

Helper text under the minimum field:

> Builds below this version code must update from Google Play before they can continue. Builds at or above it may be offered the latest Play release. The app file stays in Play Console.

The existing publish checkbox stays for Play and iOS: **I verified that this store release is available to the intended audience.** Delete the amber sentence `Direct APK publication requires a server-verified artifact.` A Play draft does not need `artifactState === "verified"`.

Preview still invalidates when the form changes. The minimum cannot be lowered on publish, and it cannot exceed the selected Play release build. Those rules already exist in `validatePolicyTransition()` and `minimumValid()`. Apply the Android minimum only to the Play target. Stop requiring a direct release to be greater than or equal to the minimum.

Do not add a page, a permission, or a new endpoint for this.

## Backend contract

Wire format stays snake_case through the existing transformer. TypeScript names stay camelCase.

### Drafts

`POST` and update of an admin release draft:

- Android `source` must be `google_play`.
- `storeUrl` must be the validated Play listing.
- `direct_apk` is `INVALID_REQUEST`.
- iOS `app_store` behavior is unchanged.
- A Play draft has no artifact. `artifactState` is null. Do not enter `awaiting_upload`.

`validateReleaseDraft()` in `backend/src/releases/release-policy.ts` is the server check. `release-draft.dto.ts` and `release-drafts.service.ts` must match it.

### Policy selection

`validateSelection()` currently requires Android keys `minimumBuild`, `directReleaseId`, `storeReleaseId`, and `source`. Keep those keys so the stored document shape does not need a migration.

Accepted Android values:

- `source` is `google_play`. Anything else, including `direct_apk`, is `INVALID_REQUEST`.
- `directReleaseId` is `null`. A non-null id is `INVALID_REQUEST`.
- `storeReleaseId` is null or a 24-hex id of a published, or currently publishing, `google_play` release whose build is greater than or equal to `minimumBuild`.

`currentSelection()` must not report `direct_apk` as the editable source. If the stored selection is missing or is `direct_apk`, return `source: "google_play"`, `directReleaseId: null`, and the stored `storeReleaseId` unchanged. This is a read mapping for the admin form. Do not write it back unless an operator publishes or withdraws through the existing audited mutation.

`ReleasePublicationService.resolve()` selects the Android target only from `storeReleaseId` with source `google_play`. Do not load `directReleaseId` as a distributable target. Preview examples for Android include `distribution: "play"` only. Remove the `distribution: "direct"` examples.

Publishing a Play release still requires `storeAvailabilityConfirmed: true`. Withdrawal behavior for iOS and for a published Play release stays on the existing replacement-policy path.

### Public routes

| Route | New behavior |
| --- | --- |
| `GET /app-updates/policy?platform=android&distribution=play` | Unchanged success shape. `target.artifact` is null. `target.source` is `google_play`. `target.store_url` is the listing. |
| `GET /app-updates/policy?platform=android&distribution=direct` | Reject. Use the existing invalid-distribution error. Do not return an APK artifact. |
| `GET /app-updates/policy?platform=ios&distribution=app_store` | Unchanged. |
| `POST /app-updates/releases/:id/download-grants` | Does not issue a grant. Stable error, no signed URL. |
| `POST /app-updates/releases/:id/download-redirects` | Does not redirect to object storage. |
| `GET /app-updates/releases/:id` | Does not serve the APK landing HTML. |
| `POST /admin/releases/:id/uploads` and the completion route | Reject. No new object is reserved or written. |

`APP_UPDATES_ENABLED` still gates the public policy route. Do not change its default or a deployed value.

Update `backend/openapi.yaml` and `docs/backend-security/route-matrix.md` so the write schemas and these routes match the new contract. A read model may still list `direct_apk` as a historical stored source. The create schema must not offer it. Do not change `/jobs/{id}/download-grants`.

If the APK verifier, upload service, and artifact storage are then unreachable, delete that dead path and its tests instead of leaving a hidden ingest route. Keep the code if a remaining published-release read still needs the stored artifact fields to parse old documents. Parsing old fields is allowed. Accepting new bytes is not.

## Android client

Delete:

- `android/app/src/direct/`
- `android/app/src/testDirect/`
- the `direct` product flavor and `directImplementation(libs.azhon.appupdate)` in `android/app/build.gradle.kts`
- `azhon-appupdate` from `android/gradle/libs.versions.toml`
- direct-only download states and problems that no remaining code reads, including the APK checksum, signer, package, and install-permission problems, once tests no longer need them
- the `app-update-downloads` notification channel if nothing posts to it, and update `NotificationBadgeChecks` accordingly

Keep `src/play` and the Play flavor. `BuildConfig.UPDATE_DISTRIBUTION` remains `"play"`.

`UpdatePolicy.kt` accepts only `platform=android`, `distribution=play`, `source=google_play`, a null artifact, and the validated listing URL. `resolveUpdateSource()` for `play` stays `google_play`. A `direct` snapshot is `INVALID_POLICY`. `UpdateApiClient.policy()` keeps requesting `distribution=play`. Remove the download-grant call from the client if the Play installer does not use it.

The shared `UpdateCoordinator`, `UpdateGate`, `UpdateAdmission`, cache, 24-hour optional deferral, and check triggers stay. Required still blocks back navigation, playback, imports, local transfers, and notification actions. Do not cancel or delete an existing cloud job when the gate appears.

### Play installer

Replace the body of `android/app/src/play/java/com/hatem/musicmute/updates/PlayUpdateInstaller.kt`. `platformUpdatePrompt()` in the Play source set can stay unused; the shared `UpdateGate` is the UI.

`startUpdateFlowForResult` needs an `ActivityResultLauncher` registered in `MainActivity` before the activity is started. Register `ActivityResultContracts.StartIntentSenderForResult` there. Do not store the `Activity` or the launcher in `VocalApplication`. `MainActivity` binds the launcher to the installer for its lifetime and clears it in `onDestroy`. `onUpdate` and `onResume` use that binding.

Pass the current update decision and `minimumBuild` from the validated policy snapshot into the installer along with the target so it can apply the correct threshold. Do not infer the required minimum from the target build. A required decision without a valid minimum is `INVALID_POLICY` and must not bypass the gate.

Flow:

1. Validate the target with the existing `validateGooglePlayTarget()`. A bad target is `INVALID_POLICY` and does not open a URL.
2. Ask `AppUpdateManager` for `AppUpdateInfo`.
3. Required decision: start `IMMEDIATE` only when an update is available, immediate is allowed, and `availableVersionCode()` is greater than or equal to `minimumBuild`. Accept a build below the dashboard target if it meets the minimum. For example, installed build `10`, minimum `12`, target `15`, and Play-offered build `14` must allow the immediate update.
4. Optional decision: require an available update with `availableVersionCode()` greater than or equal to the dashboard target build. Start `FLEXIBLE` when flexible is allowed; otherwise start `IMMEDIATE` only when immediate is allowed. Meeting only the minimum is not enough to start an optional update.
5. Resume from `MainActivity.onResume` through `onForeground()`. If availability is `DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS`, resume the immediate flow with the bound launcher. If a flexible download has reached `DOWNLOADED`, show a restart action that calls `completeUpdate()`. Do not restart playback on your own.
6. User cancellation of a required immediate flow leaves the blocking gate up. Cancellation of an optional flow leaves the app usable. `RESULT_IN_APP_UPDATE_FAILED` is `PLAY_UPDATE_UNAVAILABLE` with retry.
7. If Play has no update, the call fails, no applicable update type is allowed, or the available version code is below the applicable threshold (`minimumBuild` for required, dashboard target for optional), set `PLAY_UPDATE_UNAVAILABLE`. The only other action is **Open Google Play**, which opens the validated listing and nothing else. No browser URL is taken from the network beyond the target field that already passed `validateGooglePlayTarget()`.
8. A successful immediate update restarts the process. Re-evaluate the policy using the actual installed build: below the current minimum stays required; at or above the minimum but below the target is optional; at or above the target is none. In the example above, installed build `14` clears the required gate and leaves target `15` optional. Do not clear the gate merely because Play offers a qualifying build or the user accepts the update. Do not clear local library data, auth, or jobs before the restart.

Flexible progress maps to the existing `UpdateInstallState.Downloading`. Do not show an APK percentage for an immediate Play full-screen flow. English and Arabic copy in `src/main/res/values/strings.xml` and `values-ar/strings.xml` must say the update is installed by Google Play. Remove direct-variant `app_update_strings.xml` with `src/direct`. Do not tell the user to install an APK or to allow unknown apps.

`createUpdateInstaller` no longer takes a download client. Tests in `src/testPlay` replace `PlayUpdateInstallerTest`. Cover: valid target starts immediate for required and flexible for optional; a required update accepts an available build equal to the minimum or between the minimum and target; a required update below the minimum is rejected; an optional update below the target is rejected and one equal to the target is accepted; a required decision with a missing or invalid minimum fails closed; no rejected flow opens a foreign URL; cancel of required stays failed without clearing the decision; store fallback launches only the listing; missing launcher fails closed; `onForeground` resumes an in-progress immediate update. Fake `AppUpdateManager`. Do not call Play from a unit test.

## Tests and docs

Update the tests that encode Direct APK as a supported write path. The important files are:

- `backend/src/releases/release-policy.spec.ts`
- `backend/src/releases/release-policy.service.spec.ts`
- `backend/src/releases/release-publication.service.spec.ts`
- `backend/src/releases/release-drafts.service.spec.ts`
- `backend/src/releases/release-download.service.spec.ts`
- `backend/src/releases/release-controller-security.spec.ts`
- `backend/src/releases/release-upload.service.spec.ts` and the verifier specs, if that path is removed
- `dashboard/src/features/releases/release-draft-form.test.tsx`
- `dashboard/src/api/backend-contract-alignment.test.ts`
- `dashboard/src/test/dashboard-fixtures.ts`
- `dashboard/e2e/backend-contract.spec.ts`
- `android/app/src/test/java/com/hatem/musicmute/updates/*`
- `android/scripts/test_check_play_release.py` only if its fixtures still claim direct distribution is a Play-client success

Add or adjust cases for:

- Android draft with `google_play`, no file, and the fixed listing URL.
- `direct_apk` draft and a non-null `directReleaseId` are rejected.
- Public `distribution=direct` is rejected.
- Public `distribution=play` still returns `required` below the minimum, `optional` between minimum and target, and `none` at or above the target, with `artifact: null`.
- With installed build `10`, minimum `12`, target `15`, and Play-offered build `14`, the required immediate flow starts. After installation, build `14` clears the required gate and leaves only an optional update to `15`. Offering or accepting build `14` before installation must not clear the gate.
- Download-grant and upload routes do not return a storage URL.
- A historical `direct_apk` document still parses on admin read and cannot be published or selected.

Update `android/README.md` and `docs/google-play-release.md` so they no longer tell an operator to preserve the direct channel or describe azhon, the install permission, or the APK grant. Say that the dashboard records the Play version code and the app installs it through Play In-App Updates.

## Checks

Run the focused tests you changed. From the component directories, not the repo root:

- backend release unit tests that this task touches
- dashboard unit tests for the release form and contract alignment
- Android `:app:testPlayReleaseUnitTest` for the update package, or the existing unit-test task that covers `src/test` and `src/testPlay`

Do not assemble a release bundle unless the flavor deletion fails those tests. Do not run `check-play-release.py --live`. That reads production. A local `--bundle` check is allowed only if a bundle already exists or you built one locally, and it does not publish.

In the final report, name the checks that ran and say that no release was published and no production policy was edited.

## Out of scope

- Uploading an AAB to Play Console, submitting review, or changing a Play listing.
- Raising the live minimum build, publishing release `0.1.15` / build `16`, or clearing the current Play 503.
- iOS App Store behavior, macOS updates, web, and Chrome extension updates.
- Rewriting historical Mongo release rows or deleting objects already stored for old direct APKs.
- Any path that puts `REQUEST_INSTALL_PACKAGES` back, loads a downloaded `dex` or `so`, or installs an APK with `PackageInstaller`.
