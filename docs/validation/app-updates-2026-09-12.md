# Android in-app update validation — 2026-09-12

## Scope and production diagnosis

This run implemented and published the Android direct-distribution bootstrap for
version `0.1.2` / build `3`. It enabled the existing production release-delivery
feature in CapRover and restarted the backend, but did not deploy new backend
code or install an APK on a device.

The published build-2 landing page returned HTTP 200. `GET .../open` returned
404 because the download handoff is intentionally a POST route. Both the landing
page's `POST .../open` and the app contract's `POST .../download` returned the
typed `RESOURCE_NOT_FOUND` response. The production configuration inspection
showed no `APP_UPDATES_ENABLED` value, while the backend defaults that flag to
`false`; `ReleaseDownloadService` deliberately returns `RESOURCE_NOT_FOUND`
when it is disabled. The runtime was then changed to
`APP_UPDATES_ENABLED=true` and restarted with the user's explicit approval.

Build 2 predates the new updater and is immutable. It cannot gain an in-app
dialog after publication. Build 3 is therefore the bootstrap artifact that must
first be distributed through the existing landing-page flow. Future higher
builds can use the in-app dialog.

## Production publication proof

The dashboard created release `6aa5328eacaa5fc2d2097482`, uploaded the signed
direct APK, and independently marked it verified. A valid compare-and-set policy
preview showed build 1 as required, build 2 as optional, build 3 as current, and
build 4 as newer than the target. Fresh Google reauthentication then published
the release and policy revision 2 with minimum build 2.

Public read-back after publication showed:

- direct policy: HTTP 200, revision 2, target `0.1.2` / build 3;
- release landing page: HTTP 200;
- POST open handoff: HTTP 303;
- POST download grant: HTTP 200.

The APK was downloaded again through the production grant into a fresh temporary
directory. Its `79,324,227` bytes and SHA-256
`a16528d6ace6106d0898a25b75c59a83a2a290ac71cab09cf0aa2cf0d371e1fc`
matched the grant exactly. Independent archive inspection confirmed package
`com.hatem.musicmute`, version `0.1.2`, build `3`, and signer SHA-256
`417ee3745623721dd420d8056b0cc0a97d0ca5c571fa8da771f1eeed009f4b6d`.

## Automated validation

Working directory for Gradle commands: `android/`.

| Command | Result | Evidence boundary |
| --- | --- | --- |
| `./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest` | Passed | Both flavor JVM suites passed, including policy validation, 15-minute/24-hour boundaries, serialized state restoration, typed processing rejection, preserved cloud jobs, source pause, grant expiry/storage checks, and APK validation boundaries. |
| `./gradlew :app:assembleDirectDebug :app:assemblePlayDebug :app:lintDirectDebug :app:lintPlayDebug` | Passed | Both debug variants assembled; both lint tasks reported no errors. |
| `./gradlew :app:assembleDirectRelease :app:bundlePlayRelease` | Passed | Existing release signing configuration produced a direct APK and Play AAB. This is local packaging proof, not publication proof. |
| `./gradlew :app:assembleDirectAuthE2e :app:assemblePlayAuthE2e` | Passed | The existing synthetic auth build type remains available for both distribution flavors. No device flow ran. |
| `git diff --check` | Passed | No whitespace errors were found at the reviewed checkpoint. |

Resolved dependency inspection showed:

- direct runtime: `io.github.azhon:appupdate:4.3.6` only;
- Play runtime: `com.google.android.play:app-update:2.1.0` and
  `app-update-ktx:2.1.0`, with no azhon dependency.

Merged manifest inspection showed the direct variant contains
`REQUEST_INSTALL_PACKAGES`, azhon's download service, file provider, and dialog
activity. Its release application explicitly keeps cleartext traffic disabled,
and the updater provider is restricted to the `app-updates/` subdirectory of
the app's internal/external cache rather than the dependency's broad default
paths. The Play merged manifest contains none of those direct-installer
capabilities.

## Release artifact inspection

Direct APK:
`android/app/build/outputs/apk/direct/release/app-direct-release.apk`

- size: `79,324,227` bytes;
- SHA-256: `a16528d6ace6106d0898a25b75c59a83a2a290ac71cab09cf0aa2cf0d371e1fc`;
- package: `com.hatem.musicmute`;
- version: `0.1.2` / build `3`;
- APK Signature Scheme v2 verification: passed;
- signer certificate SHA-256:
  `417ee3745623721dd420d8056b0cc0a97d0ca5c571fa8da771f1eeed009f4b6d`.

Play bundle:
`android/app/build/outputs/bundle/playRelease/app-play-release.aab`

## Remaining proof

- The direct flow downloads and verifies inside MusicMute, but Android always
  owns the final package-install confirmation UI. Unknown-source permission,
  installer cancellation, process replacement, and successful in-place upgrade
  remain unverified on a real Android target because Android device/UI execution
  was not authorized.
- The Play variant currently opens the verified package listing as its safe
  fallback. A published Play test artifact, Play ownership, signing compatibility,
  and native flexible/immediate update flows remain separate unverified work.
