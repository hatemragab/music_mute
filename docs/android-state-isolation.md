# Android UI state isolation

Local source audit and changes, 2026-09-26. Branch
`hatem/android-state-isolation`, created in a separate managed worktree from
freshly fetched `origin/main` (`46dda799bec742fb8b9f58fb103e7de9c453ecc5`).

## Findings and changes

Compose recomposition is not necessarily a full redraw or Activity recreation.
This audit identified broad observable-state reads that unnecessarily invalidate
parent composition scopes. No device frame-time or recomposition trace was taken.

| Area | Before | After |
| --- | --- | --- |
| Full player | Every 500 ms position snapshot enters the whole player; slider drag state belongs to its broad content scope. | Controls observe position-free, distinct snapshots; only `PlaybackProgress` collects position and owns drag state. Artwork, title, queue and mode controls do not receive position ticks. |
| Home/Library mini-player | Position and dragging invalidate mini-player content including title and buttons. | Shared progress component owns those updates; controls observe distinct snapshots. |
| Result transfers | Activity collects the complete artifact progress map and passes it into navigation. | Navigation receives the flow; only the job detail route collects its selected job's progress. Other jobs' byte updates are filtered. |
| Navigation/Home/Library | Rebuilding task presentations, scanning selected tasks, deriving titles and effect keys reads broad snapshots in the shell. | Task/title/selection projections use derived state; import/history effects observe snapshots outside composition. Library query and processing state reads stay in route content or callbacks. |
| Account verification/password reset | A one-second clock invalidates the whole account/form composition. | A shared lifecycle-aware cooldown scope updates only the resend/submit button content, and recomputes the monotonic deadline after foreground resume. |
| Decorative waves/press animations | Wave phase is read in Canvas drawing; button scale in graphicsLayer. | Already appropriately scoped; unchanged. |
| Settings, accent, about, auth/recovery | Preference/session changes or explicit form actions update their owning UI. | No playback-position subscription introduced; recovery behavior and preference architecture unchanged. |

The existing Media3 controller, 500 ms progress cadence, lifecycle collection,
queue semantics, realtime transport, authenticated commands and visual layout
remain in place. Drag state resets across track and original/voice switching;
seeking is disabled during switching to avoid seeking the wrong timeline.
State-based player overloads remain available for previews.

Main implementation files (under `android/app/src/main/java/com/hatem/musicmute`):
`MainActivity.kt`, `ui/VocalApp.kt`, `playback/PlaybackObservation.kt`,
`ui/player/{PlayerScreen,FullPlayer,PlaybackProgress,PlaybackPresentation}.kt`,
and `ui/auth/{AuthScreen,AccountScreen,AccountOverlays,CooldownContent}.kt`.

## Local validation

JDK 17, installed Android SDK 36. No dependencies added. No configured Kotlin
formatter exists in this component; formatting was reviewed and
`git diff --check` passed.

From `android/`, with `JAVA_HOME`, `ANDROID_HOME` and `ANDROID_SDK_ROOT` set:

```sh
./gradlew :app:testDirectAuthE2eUnitTest \
  --tests 'com.hatem.musicmute.playback.*' \
  --tests 'com.hatem.musicmute.ui.*' \
  --tests 'com.hatem.musicmute.state.*' \
  --tests 'com.hatem.musicmute.processing.*' \
  --tests 'com.hatem.musicmute.auth.*' \
  :app:lintDirectAuthE2e :app:assembleDirectAuthE2e :app:assemblePlayAuthE2e
```

Passed: **225 tests, 40 suites, zero failures/errors**, lint and both fixture APK
assemblies. Regression coverage includes suppressing 100 position ticks and
seeks for control observers while retaining pause, buffering, errors, timeline,
queue, track clearing, speed and mode updates; seek eligibility during source
switching; and exact/expired monotonic cooldown boundaries.

The earlier unfiltered `:app:testDirectAuthE2eUnitTest` run reported **275 tests,
one failure** in unchanged
`DirectUpdateInstallerTest.directBuildCanMigrateToTheVerifiedPlayListingWithoutDownloadingAnApk`.
Its production Play Store URL names `com.hatem.musicmute`, while the AuthE2e
variant uses `com.hatem.musicmute.authtest`; the installer validates against
`BuildConfig.APPLICATION_ID`. The test/installer were not changed. Therefore the
whole fixture suite is not reported as green.

AuthE2e uses the repository's synthetic Firebase configuration. These builds do
not verify production Firebase, a signed release, real media playback or device
smoothness. Android device/UI execution is outside the authorized device scope
(the permitted iPhone simulator cannot run this Kotlin app). Runtime acceptance
still needs a separately authorized Android target: inspect recomposition counts
while playing/dragging, downloading while on other routes, searching Library,
and running reset/verification cooldowns; also check track/source switching,
background/resume, English/Arabic and retained scroll position.

No app release or deployment was performed.
