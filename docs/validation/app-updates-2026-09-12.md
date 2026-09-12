# Android in-app update validation — 2026-09-12

## Scope and production diagnosis

This run implemented and published the Android direct-distribution bootstrap.
Build `3` was published first, then pre-merge review found that the dependency's
download manager replaced the process-wide TLS trust manager. The app-owned
downloader was rewritten to preserve Android's default certificate and hostname
verification, bound the stream to the signed grant size, and repaired cancellation
and timeout state. The reviewed replacement is version `0.1.3` / build `4`.

The run enabled the existing production release-delivery feature in CapRover and
restarted the backend, but did not deploy new backend code or install an APK on a
device.

The published build-2 landing page returned HTTP 200. `GET .../open` returned
404 because the download handoff is intentionally a POST route. Both the landing
page's `POST .../open` and the app contract's `POST .../download` returned the
typed `RESOURCE_NOT_FOUND` response. The production configuration inspection
showed no `APP_UPDATES_ENABLED` value, while the backend defaults that flag to
`false`; `ReleaseDownloadService` deliberately returns `RESOURCE_NOT_FOUND`
when it is disabled. The runtime was then changed to
`APP_UPDATES_ENABLED=true` and restarted with the user's explicit approval.

Build 2 predates the new updater and is immutable. It cannot gain an in-app
dialog after publication. Build 4 is therefore the reviewed bootstrap artifact
that must first be distributed through the existing landing-page flow. Future
higher builds can use the in-app dialog.

## Production publication proof

The dashboard created replacement release `6aa541b9acaa5fc2d209748f`, uploaded the
signed direct APK, and independently marked it verified. A valid compare-and-set
policy preview showed build 1 as required, build 2 as optional, build 4 as
current, and build 5 as newer than the target. Fresh Google reauthentication
then published the release and policy revision 3 with minimum build 2. The
earlier build-3 release remains published but is no longer the policy target.

Public read-back after publication showed:

- direct policy: HTTP 200, revision 3, target `0.1.3` / build 4;
- release landing page: HTTP 200;
- POST open handoff: HTTP 303;
- POST download grant: HTTP 200.

The APK was downloaded again through the production grant into a fresh temporary
directory. Its `79,324,371` bytes and SHA-256
`a0580e93428443bdc5f5db3a6ef173b18e9c1f4978cefa83491b015bdb60a23d`
matched the grant exactly. Independent archive inspection confirmed package
`com.hatem.musicmute`, version `0.1.3`, build `4`, and signer SHA-256
`417ee3745623721dd420d8056b0cc0a97d0ca5c571fa8da771f1eeed009f4b6d`.

## Automated validation

Working directory for Gradle commands: `android/`.

| Command | Result | Evidence boundary |
| --- | --- | --- |
| `./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest` | Passed | 368 flavor JVM tests passed (189 direct and 179 Play), including policy validation, timeout/cancellation classification, 15-minute/24-hour boundaries, serialized state restoration, typed processing rejection, preserved cloud jobs, source pause, grant expiry/storage checks, bounded streams, TLS trust preservation, and APK validation boundaries. |
| `./gradlew :app:assembleDirectDebug :app:assemblePlayDebug :app:lintDirectDebug :app:lintPlayDebug` | Passed | Both debug variants assembled; both lint tasks reported no errors. |
| `./gradlew :app:assembleDirectRelease :app:bundlePlayRelease` | Passed | Existing release signing configuration produced a direct APK and Play AAB. This is local packaging proof, not publication proof. |
| `./gradlew :app:assembleDirectAuthE2e :app:assemblePlayAuthE2e` | Passed | The existing synthetic auth build type remains available for both distribution flavors. No device flow ran. |
| `git diff --check` | Passed | No whitespace errors were found at the reviewed checkpoint. |

Resolved dependency inspection showed:

- direct runtime: `io.github.azhon:appupdate:4.3.6`, used only for its
  FileProvider/installer integration; MusicMute owns the HTTPS download stream;
- Play runtime: `com.google.android.play:app-update:2.1.0` and
  `app-update-ktx:2.1.0`, with no azhon dependency.

Merged manifest inspection showed the direct variant contains
`REQUEST_INSTALL_PACKAGES` and azhon's file provider. Its unused download
service and dialog activity are explicitly removed. The release application
keeps cleartext traffic disabled, and the updater provider is restricted to the
`app-updates/` subdirectory of the app's internal/external cache rather than the
dependency's broad default paths. The Play merged manifest contains none of
those direct-installer capabilities.

## Release artifact inspection

Direct APK:
`android/app/build/outputs/apk/direct/release/app-direct-release.apk`

- size: `79,324,371` bytes;
- SHA-256: `a0580e93428443bdc5f5db3a6ef173b18e9c1f4978cefa83491b015bdb60a23d`;
- package: `com.hatem.musicmute`;
- version: `0.1.3` / build `4`;
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
- The superseded build-3 release remains published and its old direct link may
  still be used. Production policy and all normal update discovery now target
  build 4. Withdrawing build 3 is a separate destructive release-lifecycle action.
