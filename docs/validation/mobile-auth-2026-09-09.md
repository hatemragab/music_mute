# Native mobile authentication validation — 2026-09-09

## Scope and result

Android and iOS now have mandatory Firebase sign-in, email/password registration and login,
platform social authentication (Google on Android, Apple on iOS), optional email verification,
password recovery, same-account method management, registered installations, session restoration,
local sign-out, and logout-all. Backend bootstrap is required for first entry. Existing local
audio, download, playback, history, and export implementations remain under their existing owners.

Implementation is local only. No commit, push, deployment, publication, live-account creation,
provider-console mutation, or real mail transmission was performed for this work. Account deletion
is tracked separately in [the task list](../tasks/mobile-auth.md).

## Main implementation paths

| Responsibility | Android | iOS |
| --- | --- | --- |
| Session lifecycle | `android/app/src/main/java/com/hatem/musicmute/auth/AuthSessionCoordinator.kt` | `ios/Vocal/Auth/AuthSessionModel.swift` |
| Identity and providers | Same `auth/` directory: `FirebaseAuthGateway.kt`, `GoogleCredentialProvider.kt` | `ios/Vocal/Auth/FirebaseAuthGateway.swift`, `AppleCredentialProvider.swift` |
| HTTP, contract, installation storage | Same `auth/` directory: API client, configuration, models, installation store | `ios/Vocal/Auth/`: corresponding Swift files |
| Gate and account UI | `android/app/src/main/java/com/hatem/musicmute/ui/auth/` | `ios/Vocal/UI/Auth/` |
| Composition/configuration | `MainActivity`, `VocalApplication`, `VocalApp`, Settings, Gradle catalog/build file, EN/AR resources | `VocalApp`, Settings, `project.yml`, generated Xcode project, entitlement, EN/AR resources |
| Focused tests and device fixture | `android/app/src/test/java/com/hatem/musicmute/auth/AuthContractTest.kt`, `android/app/src/authE2e/`, `android/e2e/server.mjs` | No new runtime suite per user instruction |

## Android checks

Executed from `android/`, with JDK 17 and the existing Android SDK:

```sh
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-17.0.2.jdk/Contents/Home \
ANDROID_HOME="$HOME/Library/Android/sdk" \
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug \
  :app:assembleRelease :app:assembleAuthE2e
```

Result: **BUILD SUCCESSFUL**, 43 tests, zero failures/errors/skips. This includes 11 focused auth
cases and 32 existing tests. Auth cases cover platform serialization, unsafe release origins,
last usable method, 401 refresh/replay coalescing, bearer isolation, non-replayed mail/logout,
stale UID responses, cooldown parsing, malformed success payloads, and canceled underlying SDK
mutation completion. Lint: zero errors, 24 advisory warnings (22 dependency/tooling notices,
one intentional optional-resource lookup, one URI convenience suggestion).

Kotlin auth and integration sources were formatted with ktfmt 0.64. `git diff --check` and
`node --check android/e2e/server.mjs` passed. Full test and lint reports are generated under
`android/app/build/`; build outputs are not source deliverables.

## Connected Android account flows

Only the connected Xiaomi `23043RP34G`, Android 14, serial `$ANDROID_DEVICE_SERIAL`, was used for app runtime
checks. Direct ADB interaction was used; no Maestro suite. The separate
`com.hatem.musicmute.authtest` package used official Firebase Auth SDK calls against the disposable
`demo-musicmute` Auth Emulator, an isolated instance of the actual compiled backend, MongoDB,
and Redis. It did not use the normal app's accounts or local audio data.

| Check | Observed result |
| --- | --- |
| Signed-out gate and email registration | Sign-in required; registration completed SDK authentication and actual backend bootstrap, then opened Home with unverified email allowed. |
| Optional verification | UI request produced an emulator `VERIFY_EMAIL` action; applying it through the local control endpoint followed by “I have verified” updated account status. No real mailbox used. |
| Recovery | UI request produced `PASSWORD_RESET`, generic accepted copy, and disabled resend countdown. No real mailbox used. |
| Account/installations | Profile rendered, current Xiaomi installation identified, single password method could not be removed. |
| Local logout and email login | Sign-out closed the gate; email/password sign-in reopened the same prepared account. |
| Google fixture sign-in | Synthetic Google ID credential passed through Firebase SDK and backend bootstrap. Real Credential Manager prompt is not covered. |
| Google unlink and relink | Current-password reauthentication succeeded; provider list changed password+Google → password → password+Google while retaining the same Firebase UID. |
| Process restart | Force-stop/relaunch restored the previously bootstrapped account and Home. |
| API connectivity loss | Removing only the fixture API forwarding, then relaunching, preserved local entry and displayed explicit cached/offline account state. |
| Reconnection | Restoring API forwarding and refreshing retained Account navigation and replaced offline state with fresh processing-access status. |
| Android Back | Account returned to the existing Settings screen. |
| English/Arabic | Account, status, logout confirmation, and sign-in rendered in Arabic/RTL; language was returned to English afterward. |
| Logout-all | Confirmed from UI, returned to sign-in; emulator account `validSince` advanced from `1788908352` to `1788908739`. Other fixture account timestamp was unchanged. |

The tests found and corrected omitted default `platform` serialization in bootstrap requests,
account navigation loss during refresh, and network-security XML lint errors. Scoped reviews
also closed SDK cancellation ordering, generation/UID checks, device revision reconciliation,
missing-profile recovery, atomic-store recovery, and stale/offline processing-access handling.

### Password-link emulator limitation

Adding a password to the Google-only fixture through `FirebaseUser.linkWithCredential` returned
`EMAIL_ALREADY_IN_USE`. Inspection of pinned `firebase-tools` 15.29.0's Auth Emulator `signUp`
handler showed its existing-email rejection precedes matching the supplied ID-token user.
The same order was present in upstream source when checked. This is a **blocked validation case**,
not a passing link test. The app retains the documented Firebase link API; no emulator patch or
unsupported password-update workaround was added.

To finish independent unlink/relink/logout checks, a password was seeded only into the disposable
fixture with the emulator admin endpoint. Subsequent same-UID Google unlink/relink results are
valid for that prepared fixture; the seed is explicitly not proof that password linking works.
Live-project password linking remains unverified. See [Firebase account linking](https://firebase.google.com/docs/auth/android/account-linking)
and [the emulator operation source](https://github.com/firebase/firebase-tools/blob/v15.29.0/src/emulator/auth/operations.ts).

After the initial run, cleanup stopped the isolated services and removed their forwarding. The
user then tried Google in the still-installed test app and encountered service-unavailable.
The foreground package and synthetic-build banner confirmed it was the isolated variant.
Restarting the fixture and restoring its two ADB reverse mappings fixed that reported failure;
the same Google button reopened Home on the device. The restarted fixture and forwarding are
left running for user review, and require the connected development computer. They are temporary
test infrastructure, not a deployed service. The pre-existing backend was untouched and no
production data was cleared.

## iOS checks

Executed from `ios/`:

```sh
xcodegen generate --spec project.yml
xcrun swift-format lint --recursive Vocal
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath DerivedData-auth \
  build CODE_SIGNING_ALLOWED=NO
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath DerivedData-auth-release \
  build CODE_SIGNING_ALLOWED=NO
```

Both unsigned builds succeeded; formatter, plist lint, English/Arabic key parity, and exact
Firebase SDK 12.18.0 linkage checks passed. Generic destinations compile without launching a
simulator/device. Per the user's later execution instruction, no iOS runtime, unit/UI/E2E,
Apple prompt, account, or mailbox test was run. Unsigned compilation is not distribution-signing
or Apple capability proof. Final scoped review approved all six original findings plus the
refresh-gate regression after fixes and incremental builds. In particular, obsolete offline
results cannot replace a newer session, and ordinary account-refresh service failures preserve
an already authenticated user's local access while clearing stale processing-access status.

## Configuration and remaining limits

### Follow-up: switching isolated Google accounts

The user chose to retain isolated test accounts and requested account selection after logout.
The AuthE2e provider override now opens a cancellable, EN/AR-labeled picker for two synthetic
Google identities on every attempt. It does not cache a selection. Normal Debug/Release builds
retain the native Credential Manager flow and existing Firebase/provider-state logout cleanup.

Validated on connected Android `$ANDROID_DEVICE_SERIAL`: sign out of the first account, open the picker,
choose `musicmute-google-2@example.test`, observe that profile after SDK/backend sign-in, sign out
again, cancel the picker without an error or stuck loading, then reopen it. Updated test APK
installed successfully. `:app:assembleAuthE2e :app:compileDebugKotlin :app:compileReleaseKotlin`,
ktfmt, and `git diff --check` passed. This proves synthetic account switching only.

### External configuration

- Debug defaults to `http://127.0.0.1:3000`; connected Android uses an explicit ADB reverse.
  Release needs a supplied HTTPS origin (`-PauthApiUrl=...` on Android,
  `MUSICMUTE_API_BASE_URL=...` on iOS). No confirmed production API origin was supplied;
  unconfigured Release backend setup fails closed. See platform READMEs.
- The Firebase Android public client config contains the web OAuth client ID. Read-only Firebase
  inspection confirmed the existing upload certificate is registered; the current local debug
  certificate is not. Actual Google login needs the certificate for the installed build registered.
- Live Google/Apple login, production password/provider linking, Apple team/entitlement/relay
  readiness, real verification/reset delivery, and deployed-backend behavior remain unverified.
- The device run covered the listed account flows on one connected tablet. It did not exercise
  every SDK error, font size, device, cross-device race, or audio/download interaction.
- Offline sessions discover remote revocation on the next successful online check. Last-method
  protection is client-local and cannot atomically coordinate Firebase mutations on other devices.
