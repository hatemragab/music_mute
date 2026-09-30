# Native R2 rollout

## Current-main validation — 2026-10-01

The new candidates use the original main checkout, based on commit
`41f5aa2d2db69ab5f53da755414052a6f0ca1e69` plus the preserved local native release
version changes. This includes PR 51's account verification messaging and
reduced/zero-quota handling, in addition to the R2 upload contract. MongoDB,
paired workers, signing inputs, and prior release artifacts were preserved.

### Android build 14

Android advanced from **0.1.12 (13)** to **0.1.13 (14)** using the existing signer.

- Artifact: `artifacts/MusicMute-0.1.13-build-14-R2-main-41f5aa2d-release.apk`.
- Size: **5,802,771 bytes**.
- SHA-256: `f6cf1f249eb677038c25fb04df1cddf5c36b5ebc25e65600ed10fa983966a0d7`.
- Signer SHA-256: `417ee3745623721dd420d8056b0cc0a97d0ca5c571fa8da771f1eeed009f4b6d`.
- Independent package inspection: `com.hatem.musicmute`, version 0.1.13/build 14,
  minimum SDK 26, target SDK 36.
- `apksigner verify --verbose --print-certs`: passed, one expected signer and APK
  v2 signature. The saved APK bytes match the build output.
- Focused DEX/JSON/XML/properties marker scan passed for server storage-secret,
  private-key, and Firebase Admin markers; this is not exhaustive secret detection.

The same JDK 17/SDK 36 Gradle command recorded below passed again on current main:
`:app:testDirectDebugUnitTest :app:lintDirectDebug :app:lintDirectRelease
:app:assembleDirectRelease`. Results: **324 JVM tests across 58 suites**, zero
failures, errors, or skips; both lint variants and release build passed. Existing
lint/compiler warnings remain. No Android device/UI test ran.

Direct Android release **`6abd7ec2e1184ed3926217da`** is published through the
normal administrator dashboard flow and selected by **policy revision 4**,
targeting **0.1.13/build 14** while preserving **minimum build 11**. Builds 11–13
receive an optional update to 14; builds below 11 retain the existing required
minimum. Browser upload reserved the artifact, passed the R2 preflight and PUT,
and completed server verification with artifact state **Verified**. Store-channel
selections were preserved; no Google Play release was submitted.

Independent browser download verification obtained **HTTP 200 from R2** for the
complete **5,802,771-byte** APK and matched the SHA-256 and signer SHA-256 above.
The quoted ETag is `"55d2b92e47ce4b4984c2bc9e97d0c22f"`. Sanitized proof is retained
in ignored `artifacts/r2-rollout/android14-r2-download-proof.json`, with policy
read-back in `artifacts/r2-rollout/android14-r2-published-policy.jpg`; the presigned
URL was not retained. This proves APK delivery, not Android installation, runtime
behavior, or end-to-end audio processing. The historical build 13 proof below
remains valid for that earlier release.

### New iOS unsigned archive

The unpublished iOS candidate remains **0.1.2 (3)**. XcodeGen regenerated the
project for the current source; existing Firebase client configuration remained
private and ignored.

- **169 unit tests passed**, zero failures, on the existing iPhone 17 Pro/iOS 26.0
  simulator, UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`, with parallel testing
  disabled. These include the new quota and backend-confirmed verification tests.
- Recursive `swift-format lint` exited successfully with only the pre-existing
  `AuthAPIClient.swift` warnings; `plutil -lint` passed for the generated project.
- A new Release archive passed at
  `artifacts/MusicMute-0.1.2-build-3-R2-main-41f5aa2d-20261001-unsigned.xcarchive`.
  The archive command below was rerun with this unique `-archivePath`; the prior
  archive was preserved.
- Independent inspection confirmed arm64, `com.hatem.musicmute`, version
  0.1.2/build 3, production API origin `https://api.music-mute.com`, and the
  Firebase client resource. Executable SHA-256:
  `59abc6223c05b256f6bbe0f6316bbfefcd576a0841e437e6f082457f4044c7fc`.
  A sibling ignored `.evidence.json` retains these details.
- `codesign -dv` confirms that the app is unsigned. No IPA export, Apple portal,
  TestFlight, or App Store action occurred; the MusicMute team/profile and an
  explicit distribution channel are still needed.

These are unit/build checks. They do not establish real Firebase/Apple sign-in,
APNs delivery, audible playback, an Android installation, or an end-to-end R2
processing job. No new native app logic or policy was edited for this rebuild;
private inputs and generated artifacts remain ignored. No commit or push was
performed.

## Earlier rollout — 2026-09-30

This record covers the original main checkout, based on commit
`cfc3b12ca7a3839e499794505f3dd4424d3a9881`, including its current native changes.
The earlier migration worktree checks are separate and are not the evidence for
these release artifacts. Existing MongoDB and paired workers were not changed.

### Android direct release

Source version is **0.1.12 (13)**, advanced from 0.1.11 (12). The APK includes the
R2 upload contract and the current main checkout's playback and notification
changes. Signing reuses the existing ignored upload keystore; it was not regenerated.

- Artifact: `artifacts/MusicMute-0.1.12-build-13-R2-release.apk`.
- Size: **5,802,311 bytes**.
- SHA-256: `3b736c4d1d9dc27dbbde7aa1876e9f32ce9df374fe5087aa3eed2a160acdcf97`.
- Signer SHA-256: `417ee3745623721dd420d8056b0cc0a97d0ca5c571fa8da771f1eeed009f4b6d`.
- Package: `com.hatem.musicmute`; minimum SDK 26, target SDK 36.
- `apksigner verify --verbose --print-certs`: passed, one signer, APK v2 signature.
- APK marker scan found no server storage-secret or private-key markers. This is
  a focused check, not a claim that arbitrary credentials can always be detected.

From `android/`, the following command passed with JDK 17 and Android SDK 36:

```sh
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-17.0.2.jdk/Contents/Home \
ANDROID_HOME="$HOME/Library/Android/sdk" \
./gradlew :app:testDirectDebugUnitTest :app:lintDirectDebug \
  :app:lintDirectRelease :app:assembleDirectRelease --console=plain
```

JVM results: **318 tests across 58 suites, no failures, errors, or skips**.
Debug and Release lint passed with existing warnings. No Android device or UI
test ran; these local checks do not establish physical-device execution or
end-to-end R2 audio processing.

Direct Android release **`6abd5a2b389a19ac068c1a07`** is published and selected by
**policy revision 3**, targeting **build 13** while preserving **minimum build 11**.
Builds 11 and 12 therefore receive an optional update to 13; builds below 11
remain subject to the existing required-update minimum. Administrator upload,
server artifact verification, publication and policy read-back are complete.

Independent download verification obtained **HTTP 200 from R2**, measured
**5,802,311 bytes**, and matched both the APK SHA-256 and signing-certificate
SHA-256 recorded above. The sanitized proof is retained in ignored
`artifacts/r2-rollout/android-r2-download-proof.json`; it records this release ID,
status, provider host, bytes, hashes and URL expiry without the presigned URL.
This establishes APK delivery from R2, not Android installation, runtime behavior,
or audio processing. The direct update grant's URL/size/hash/signer contract is
unchanged, so older direct apps can obtain the new APK. Old cloud upload code
cannot consume the new four-header R2 grant.

The Android minimum build is shared with the Play channel and was preserved at 11. No Google Play submission or new Play release was performed.

### iOS archive candidate

Source version is **0.1.2 (3)**, advanced from 0.1.1 (2), with the Xcode project
regenerated from `project.yml`. The ignored Firebase client plist was already
available in the original checkout and was bundled without exposing its contents.

From `ios/`:

```sh
xcodegen generate --spec project.yml
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath DerivedDataR2MainRollout -parallel-testing-enabled NO \
  -only-testing:VocalTests test CODE_SIGNING_ALLOWED=NO
xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath DerivedDataR2MainRollout \
  -archivePath ../artifacts/MusicMute-0.1.2-build-3-R2-unsigned.xcarchive \
  archive CODE_SIGNING_ALLOWED=NO
```

- **167 unit tests passed**, zero failures, on the existing iPhone 17 Pro / iOS 26.0
  simulator. Parallel testing was disabled; no replacement simulator was created.
- Swift format lint exited successfully with pre-existing `AuthAPIClient.swift`
  warnings. No unrelated formatting changes were made.
- Release archive passed. Independent archive inspection confirmed an arm64
  executable, `com.hatem.musicmute`, version 0.1.2/build 3, production API origin
  `https://api.music-mute.com`, and the Firebase client resource.
- `plutil -lint ios/MusicMute.xcodeproj/project.pbxproj` passed.

The archive is **unsigned**, not an installable/distributed IPA. No configured
MusicMute development team or matching local provisioning profile was found.
A team/profile supporting the app's capabilities and an explicit distribution
channel are still required for export and publication. Other applications'
profiles were not used. No Apple portal changes, IPA export, TestFlight upload,
or App Store submission occurred.

Unit fixtures and an unsigned archive do not establish real Firebase sign-in,
Apple sign-in, APNs delivery, audible playback, or an end-to-end R2 processing job.

### Source and private inputs

Native source changes are limited to Android release version/readme, iOS release
version/generated Xcode project/readme, and this validation record. Keystore,
password properties, Firebase SDK configuration, APK, archive, test results, and
artifact evidence JSON remain ignored. No signing secret was printed or tracked.
No commit or push was performed by this native release step.
