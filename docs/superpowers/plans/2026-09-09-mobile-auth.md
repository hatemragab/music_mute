# Native Mobile Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after user approval. Steps use checkbox (`- [ ]`) syntax for tracking. Do not start implementation merely because this plan exists.

**Goal:** Deliver Firebase-based native authentication and account-method management on Android and iOS, connected to the existing auth backend.

**Architecture:** Each native app receives a Firebase identity adapter, typed HTTP client, installation store, and session coordinator. Existing Compose/SwiftUI roots gate entry on session state and expose account controls through Settings. Audio remains under its existing repositories and models.

**Tech Stack:** Kotlin/Compose, Firebase Android BoM 34.18.0, Credential Manager 1.6.0, Google ID 1.2.0; Swift/SwiftUI, Firebase SPM 12.18.0, AuthenticationServices, CryptoKit, URLSession.

**Spec:** [Native mobile auth design](../specs/2026-09-09-mobile-auth.md).

## Execution update — 2026-09-09

The user authorized implementation of all ten deliverables, with fewer new tests and runtime testing only on the connected Android device. Both native implementations are present. The [task tracker](../../tasks/mobile-auth.md) and [validation report](../../validation/mobile-auth-2026-09-09.md) are the current execution record.

The detailed checklists and named test classes below retain the original planning proposal; unchecked proposed test steps do not claim execution. The later instruction replaced that broad test matrix with 11 focused Android auth tests, the existing Android suite, connected Android account-flow checks, iOS static/build validation, and scoped independent reviews. No iOS runtime tests or Maestro suite were added. Google fixture tests and the blocked emulator password-link attempt are recorded separately from unverified production OAuth and mail.

## Global constraints

- Implementation approved; preserve the agreed scope and record validation evidence separately from planning proposals.
- Work in the current repository and preserve all unrelated modified, untracked, and deleted paths. No commits, pushes, deployment, publishing, or destructive cleanup without explicit authorization.
- Require sign-in before app entry. Android supports password and Google; iOS supports password and Apple. Linking preserves Firebase UID.
- Keep email verification optional initially; send verification and reset mail only through the existing backend routes.
- Preserve local audio functions and data exactly; no upload, audio synchronization, ownership migration, or account-specific audio partition.
- Account deletion is a separate follow-up after this work, tracked in [the task list](../../tasks/mobile-auth.md).
- Native architecture, existing English/Arabic resources, RTL, themes, and accessibility remain in use. Android minSdk 26, compile/targetSdk 36, Java 17; iOS minimum 17.0.
- Use exact stable dependency pins from the spec; no alpha/beta/RC packages or extra auth wrapper packages.
- Latest device/UI target: connected Android `$ANDROID_DEVICE_SERIAL` only. No iOS runtime, Android emulator, or Maestro setup. Generic Xcode destinations below are for compilation only.
- No live test-account creation, test-mail sending, provider-setting mutation, or secret handling is implied by this plan. Local `demo-` emulator fixtures are separate from production identities.

## File and interface map

Paths below are relative to the repository root. Existing files are modified only at composition/configuration/UI integration points. New auth files have no audio dependencies.

| Responsibility | Android | iOS |
| --- | --- | --- |
| Typed identity and HTTP records | `android/app/src/main/java/com/hatem/musicmute/auth/AuthModels.kt` | `ios/Vocal/Auth/AuthModels.swift` |
| Firebase boundary | `auth/FirebaseAuthGateway.kt` under the same Kotlin package root | `ios/Vocal/Auth/FirebaseAuthGateway.swift` |
| Native provider acquisition | `auth/GoogleCredentialProvider.kt` | `ios/Vocal/Auth/AppleCredentialProvider.swift` |
| HTTP boundary/configuration | `auth/AuthApiClient.kt`, `auth/AuthConfiguration.kt` | `ios/Vocal/Auth/AuthAPIClient.swift`, `ios/Vocal/Auth/AuthConfiguration.swift` |
| Installation persistence | `auth/InstallationStore.kt` | `ios/Vocal/Auth/InstallationStore.swift` |
| Session orchestration | `auth/AuthSessionCoordinator.kt` | `ios/Vocal/Auth/AuthSessionModel.swift` |
| Auth screens | `ui/auth/AuthGate.kt`, `ui/auth/AuthScreen.kt` | `ios/Vocal/UI/Auth/AuthGate.swift`, `ios/Vocal/UI/Auth/AuthView.swift` |
| Account/provider screens | `ui/auth/AccountScreen.kt`, `ui/auth/LinkedMethodsScreen.kt` | `ios/Vocal/UI/Auth/AccountView.swift`, `ios/Vocal/UI/Auth/LinkedMethodsView.swift` |
| Devices screen | `ui/auth/DevicesScreen.kt` | `ios/Vocal/UI/Auth/DevicesView.swift` |
| Test doubles | `android/app/src/test/java/com/hatem/musicmute/auth/AuthFakes.kt` | `ios/VocalTests/AuthFakes.swift` |

The Kotlin short paths in this table expand under `android/app/src/main/java/com/hatem/musicmute/`. Each implementation task below uses that convention only for readability; tests use the test package root.

Define these boundaries in MOBILE-AUTH-01 and retain their names across subsequent tasks:

- `IdentitySnapshot`: Firebase UID, nullable email, emailVerified, set of provider IDs; no tokens.
- `ProviderId`: password, Google (`google.com`), Apple (`apple.com`).
- `InstallationReport`: exact `/auth/session` input; `InstallationMetadata`: the same fields without installationId.
- `AccountProfile`, `RegisteredDevice`, `DevicePage`, `AppPolicy`, `ProcessingAccess`, `SessionResponse`, `ProfileSyncResponse`, `MailOutcome`, `AuthFailure`: typed forms of the existing backend contract; accept unknown response fields while validating fields the UI relies on.
- `FirebaseAuthGateway`: observe identity, register/signIn with email and password, signIn with a native credential, reload identity, obtain ID token with optional force refresh, reauthenticate, link email/password, link a native credential, unlink a provider, and sign out. Kotlin uses suspend functions/Flow; Swift uses async throwing functions and a cancellable state listener. Native credentials stay inside the auth module.
- `AuthApiClient` / `AuthAPIClient`: `bootstrap(report) -> SessionResponse`, `profileSync() -> ProfileSyncResponse`, `me() -> AccountProfile`, `devices(limit, before) -> DevicePage`, `reportInstallation(id, metadata) -> RegisteredDevice`, `policy() -> AppPolicy`, `requestVerification() -> MailOutcome`, `requestPasswordReset(email) -> MailOutcome`, `logoutAll() -> Void`. The transport obtains tokens through an injected token source, not screen arguments.
- `InstallationStore`: `report(currentMetadata) -> InstallationReport`, `reconcile(serverDevice) -> InstallationReport`, read/write/clear a successful-bootstrap UID record. It retains the installation report across sign-out and writes atomically.
- `AuthSessionCoordinator` / `AuthSessionModel`: observe session state; `restore`, `signInEmail`, `registerEmail`, `signInSocial`, `retryBootstrap`, `refreshAccount`, `requestVerification`, `requestPasswordReset`, `linkPassword`, `linkSocial`, `unlinkProvider`, `signOut`, `logoutAll`. UI action results include safe failure/cooldown state. Account mutations are serialized and protected by the auth generation.

No application code samples are written at this planning stage, following the user's instruction. The tasks specify behavior, dependencies, failure cases, and validation that the implementation must supply.

## MOBILE-AUTH-01 — Typed contract and installation persistence

**Dependencies:** None. **Deliverable:** Independently tested native contract decoding and stable installation reports.

**Create:** Both `AuthModels` and `InstallationStore` files from the map; Android `auth/InstallationStoreTest.kt` and `auth/AuthModelsTest.kt`; iOS `VocalTests/InstallationStoreTests.swift` and `VocalTests/AuthModelsTests.swift`; sanitized shared JSON fixtures under `docs/testing/mobile-auth/fixtures/`.

- [ ] Read the spec, backend DTOs/presenters, manifests, existing test style, and current git status. Fixtures must match actual controller responses, including nullable email, optional deviceModel, ISO timestamps, and integer bounds.
- [ ] Add failing tests for UUID-v4 format, unchanged report retries, revision increments on upgrade/downgrade/OS change, restart persistence, concurrent atomic writes, corrupted-store errors, reinstall behavior, and preservation across sign-out.
- [ ] Add response tests for normal/relay/missing email, all provider combinations, absent optional fields, pagination null cursor, processing denial, malformed required fields, and metadataRevision above the backend limit.
- [ ] Run the new Android JVM and iOS unit suites to capture a meaningful failure before implementation.
- [ ] Implement typed records and injected storage/metadata sources. Persist the report before HTTP dispatch; do not store tokens or audio ownership. Exclude installation and bootstrap state from backup.
- [ ] Re-run the focused suites. Review tests for cross-account bootstrap-record isolation and ensure fixtures contain only synthetic identities.

**Validation:** Android `./gradlew :app:testDebugUnitTest --tests 'com.hatem.musicmute.auth.InstallationStoreTest' --tests 'com.hatem.musicmute.auth.AuthModelsTest'`; iOS shared command below with `-only-testing:VocalTests/InstallationStoreTests -only-testing:VocalTests/AuthModelsTests`.

## MOBILE-AUTH-02 — Typed backend transport and token policy

**Dependencies:** 01. **Deliverable:** All existing auth endpoints exercised against deterministic HTTP fixtures on both platforms.

**Create:** Both API client/configuration files; Android `auth/AuthApiClientTest.kt`; iOS `VocalTests/AuthAPIClientTests.swift`; development configuration instructions in `docs/testing/mobile-auth/configuration.md`.
**Modify:** Android build-config inputs in `android/app/build.gradle.kts`; iOS `ios/project.yml` and `ios/Vocal/Info.plist` for public API configuration only.

- [ ] Write failing transport tests asserting exact method/path/body, private bearer use, no bearer on reset/policy, rejection of cross-origin redirects, 15-second deadlines, 1 MiB response limit, cancellation, malformed JSON, and non-JSON server errors.
- [ ] Test coalesced forced refresh on 401, only one safe replay, no replay for mail/logout-all, sanitized typed errors, valid/invalid Retry-After, and no request when the base URL is absent or invalid.
- [ ] Implement the transport using injected HTTP and token sources. Android uses blocking network I/O only on `Dispatchers.IO`; Swift uses a dedicated URLSession configuration/delegate. No auth header follows redirects.
- [ ] Resolve the intended API origin from authorized public deployment configuration; if unavailable, record the specific configuration blocker. Release configurations reject loopback/HTTP/unconfigured origins. Local fixtures remain runnable without a deployed origin.
- [ ] Run focused suites and inspect payload/header assertions against backend controllers. Store only non-sensitive configuration evidence.

**Validation:** Android `./gradlew :app:testDebugUnitTest --tests 'com.hatem.musicmute.auth.AuthApiClientTest'`; iOS `-only-testing:VocalTests/AuthAPIClientTests`.

## MOBILE-AUTH-03 — Firebase email identity adapters

**Dependencies:** 01. **Deliverable:** Registration, email login, session observation, reauthentication, and SDK-owned token lifecycle through injectable native adapters.

**Create:** Both Firebase gateway files; Android `auth/FirebaseAuthGatewayTest.kt`; iOS `VocalTests/FirebaseAuthGatewayTests.swift`; platform auth fakes.
**Modify:** `android/gradle/libs.versions.toml`, `android/app/build.gradle.kts`, `ios/project.yml`; regenerate `ios/MusicMute.xcodeproj/project.pbxproj` only with XcodeGen after project source changes. Respect current repository policy for resolver-owned lockfiles.

- [ ] Add FirebaseAuth using the selected existing platform versions; verify resolved dependency versions and minimum platform compatibility without changing unrelated SDK versions.
- [ ] Write failure-first adapter tests for invalid credentials, disabled user, throttling, offline state, listener cleanup, cancellation, and successful identity snapshots without token exposure.
- [ ] Implement email/password registration/login and token acquisition with official APIs. Use configured Firebase password policy validation where supported, surface SDK weak-password rules safely, and never trim/normalize passwords.
- [ ] Implement reauthentication using the retained identity; reject account-switch results. Passwords and native credentials remain memory-only.
- [ ] Test account registration plus login through isolated `demo-` Firebase Auth emulator fixtures. Do not create accounts in `music-mute` during automated tests.
- [ ] Compile both platforms and re-run focused adapter tests; record emulator evidence separately from fake-adapter unit coverage.

**Validation:** Android `./gradlew :app:testDebugUnitTest --tests 'com.hatem.musicmute.auth.FirebaseAuthGatewayTest' :app:assembleDebug`; iOS `-only-testing:VocalTests/FirebaseAuthGatewayTests` plus the shared build/test command.

## MOBILE-AUTH-04 — Android Google authentication

**Dependencies:** 03. **Deliverable:** Credential Manager adapter for Google sign-in, linking, and reauthentication.

**Create:** Android `auth/GoogleCredentialProvider.kt` and test `auth/GoogleCredentialProviderTest.kt`.
**Modify:** `android/gradle/libs.versions.toml`, `android/app/build.gradle.kts`; Activity composition only where needed to supply a lifecycle-scoped provider launcher.

- [ ] Add stable Credentials/Play Services adapter 1.6.0 and Google ID 1.2.0; use Firebase's generated Web client ID resource.
- [ ] Write failing tests around the provider launcher for success, user cancellation, no credentials, unsupported credential type, missing client ID, destroyed Activity, duplicate taps, and late result after sign-out.
- [ ] Implement explicit user-initiated Credential Manager requests and convert only valid Google ID credentials to Firebase credentials. Reauthentication/linking use the existing current user instead of replacing it with sign-in.
- [ ] Clear Credential Manager session state on logout without revoking the user's Google account or deleting other credentials.
- [ ] Inspect public OAuth configuration and authorized signing fingerprints, distinguishing debug, upload certificate, and app-signing certificate. Document missing readiness; do not alter live console settings during this step without authorization.
- [ ] Run JVM tests, lint, and assembly. Record real Google UI authentication as unverified unless an Android device exception and test account are authorized.

**Validation:** `./gradlew :app:testDebugUnitTest --tests 'com.hatem.musicmute.auth.GoogleCredentialProviderTest' :app:lintDebug :app:assembleDebug` from `android/`.

## MOBILE-AUTH-05 — iOS Apple authentication

**Dependencies:** 03. **Deliverable:** AuthenticationServices adapter for Apple sign-in, linking, reauthentication, and revocation handling.

**Create:** `ios/Vocal/Auth/AppleCredentialProvider.swift`, `ios/Vocal/Vocal.entitlements`, `ios/VocalTests/AppleCredentialProviderTests.swift`.
**Modify:** `ios/project.yml` for entitlement binding; regenerate the Xcode project through XcodeGen.

- [ ] Write failing tests with an injected authorization launcher and nonce generator: unique nonce per attempt, SHA-256 request value, original nonce exchange, missing ID token, cancelled prompt, repeated callback, nil name/email, stale auth generation, and revoked credentials.
- [ ] Implement native requests with memory-only nonces/codes, official Firebase Apple credential construction, correct main-actor presentation, and no forced unwrapping of provider payloads.
- [ ] Obtain explicit in-app consent before linking Apple identity to other account data. Use a fresh authorization for each action and handle documented updated-credential errors without automatic account merge.
- [ ] Inspect Sign in with Apple entitlement, bundle/team configuration, Firebase provider enablement, and relay readiness through available authorized access. Keep signing keys and Apple secrets out of source and reports.
- [ ] Run focused tests on the designated simulator. Report Apple native prompt success, signed distribution entitlement proof, and mocked adapter proof independently.

**Validation:** iOS shared command with `-only-testing:VocalTests/AppleCredentialProviderTests`; regenerate with `xcodegen generate --spec project.yml` from `ios/` when required.

## MOBILE-AUTH-06 — Session coordinator and mandatory app gate

**Dependencies:** 01–05. **Deliverable:** Both app roots enforce the designed session lifecycle without modifying audio behavior.

**Create:** Both coordinator/model files and AuthGate files; Android `auth/AuthSessionCoordinatorTest.kt`; iOS `VocalTests/AuthSessionModelTests.swift`.
**Modify:** `android/.../VocalApplication.kt`, `android/.../MainActivity.kt`, `ios/Vocal/VocalApp.swift` for dependency composition and gate entry only.

- [ ] Write failing transition tests: signed-out launch, successful registration/sign-in bootstrap, Firebase success/backend 503, bootstrap retry without another signup, restored matching UID online/offline, changed UID, known revoked/disabled user, and missing bootstrap record.
- [ ] Add race tests for logout during bootstrap, provider callback after cancellation, overlapping foreground/token events, and an old account's HTTP response arriving after a new account signs in.
- [ ] Implement generation checks, single-flight refresh/bootstrap, safe persistent bootstrap identity, and the spec's offline fallback. New identities cannot enter before backend bootstrap succeeds.
- [ ] Mount the existing app UI only through the authenticated state. Preserve pending Android history notification navigation without using it to bypass the gate.
- [ ] Implement local sign-out and logout-all semantics, including uncertain global outcome and no automatic replay. Clear only auth-owned account state; leave existing audio stores and background behavior unchanged.
- [ ] Validate device-report reconciliation once after conflicts and avoid bootstrap loops exceeding the backend profile budget.
- [ ] Run focused coordinator tests and inspect that auth modules do not import audio persistence classes.

**Validation:** Android `./gradlew :app:testDebugUnitTest --tests 'com.hatem.musicmute.auth.AuthSessionCoordinatorTest'`; iOS `-only-testing:VocalTests/AuthSessionModelTests`.

## MOBILE-AUTH-07 — Login, registration, and recovery UI

**Dependencies:** 06. **Deliverable:** Accessible bilingual entry screens, native social buttons, and backend-limited password recovery.

**Create:** Android `ui/auth/AuthScreen.kt`, test `auth/AuthFormTest.kt`; iOS `UI/Auth/AuthView.swift`, `VocalTests/AuthFormTests.swift`, `VocalUITests/AuthUITests.swift`.
**Modify:** Android English/Arabic `strings.xml`, iOS English/Arabic `Localizable.strings`; relevant existing preview composition.

- [ ] Write failing tests for empty/malformed email, email over 254 characters, mismatched password confirmation, hidden-password behavior, duplicate submit, provider cancellation, registration error, and generic reset outcomes for known/unknown email.
- [ ] Implement login, registration, recovery, and bootstrap-retry states using the coordinator. Keep credentials out of saved-state restoration and clear them after success/cancel.
- [ ] Honor Firebase password policy, safe error mapping, server Retry-After and mail success cooldown; button timers never send another request by themselves.
- [ ] Use platform-standard provider button identity, keyboard/autofill hints, screen-reader labels, inline errors, and scrollable layouts for keyboard/large text. Auth screens retain the current language and theme.
- [ ] Add explicit screen identifiers and DEBUG-only injected fixtures for iOS UI tests; verify Release cannot activate a mock session with launch flags.
- [ ] Run form tests and designated-simulator UI scenarios for signed-out gate, registration/login success, network retry, cancellation, reset cooldown, Arabic RTL, and accessibility text sizes.

**Validation:** Android `./gradlew :app:testDebugUnitTest --tests 'com.hatem.musicmute.auth.AuthFormTest'`; iOS `-only-testing:VocalTests/AuthFormTests -only-testing:VocalUITests/AuthUITests`.

## MOBILE-AUTH-08 — Linked login methods and safe unlinking

**Dependencies:** 04–07. **Deliverable:** Existing accounts can add password/social methods and safely remove supported methods.

**Create:** Both LinkedMethods screen files; Android `auth/LinkedMethodsTest.kt`; iOS `VocalTests/LinkedMethodsTests.swift`.
**Modify:** Both Firebase adapters and session coordinators, localized resources.

- [ ] Write failing cases for password-to-social and social-to-password linking preserving UID; wrong reauthentication identity; cancelled consent; credential owned by another UID; already-linked provider; and link success followed by backend-sync failure.
- [ ] Test Apple relay email display, absent email, explicit linking consent, and no unsupported primary-email replacement. Password linking uses the actual existing account email.
- [ ] Implement reauthenticate → link on current Firebase user → reload → forced token refresh → backend profile sync. A failed profile sync is retryable without performing the identity mutation twice.
- [ ] Write unlink tests for sole provider, only-other-platform provider remaining, successful retained-provider reauthentication, stale provider list, concurrent local actions, and logout during mutation.
- [ ] Reload providers, prove a retained sign-in method on this platform, obtain confirmation, unlink, and refresh/sync. Other-platform providers are visible with a platform explanation, without adding new provider flows.
- [ ] Add clear account-collision guidance and removed-provider warning. Never merge UIDs, delete accounts, use email enumeration, or execute the data-merging examples from generic SDK docs.
- [ ] Run all linking cases in fakes and supported emulator scenarios. Check the official documented Android linking issue against the selected SDK/project before claiming live linking works.

**Validation:** Android `./gradlew :app:testDebugUnitTest --tests 'com.hatem.musicmute.auth.LinkedMethodsTest'`; iOS `-only-testing:VocalTests/LinkedMethodsTests`.

## MOBILE-AUTH-09 — Account, verification, installations, and logout UI

**Dependencies:** 06–08. **Deliverable:** Account management consumes every applicable existing auth/profile/device endpoint.

**Create:** Account and Devices screens from the file map; Android `auth/AccountActionsTest.kt`; iOS `VocalTests/AccountActionsTests.swift`.
**Modify:** `android/.../ui/VocalApp.kt` Settings integration, `ios/Vocal/UI/SettingsView.swift`, localized resources, auth coordinators.

- [ ] Write tests for optional verification remaining nonblocking, accepted/already-verified outcomes, cooldown, return-from-browser refresh, stale ID-token claim, and backend-sync retry without a second email.
- [ ] Implement account details and voluntary verification. Reload Firebase, force-refresh token, and then sync backend before showing the refreshed verification state.
- [ ] Test device list loading/error/empty/page states, duplicate page suppression, current-installation labeling, and account switch during pagination. Implement the list with no single-device revoke/delete action.
- [ ] Present server processing-policy status separately from login/local audio; validate update links and keep account recovery reachable.
- [ ] Implement explicit local/global logout controls and confirmation, including the distinction between confirmed global revocation and uncertain failure.
- [ ] Verify account screen never exposes internal Firebase tokens or revocation cutoffs and does not add profile-name/email editing endpoints.

**Validation:** Android `./gradlew :app:testDebugUnitTest --tests 'com.hatem.musicmute.auth.AccountActionsTest'`; iOS `-only-testing:VocalTests/AccountActionsTests` and account flows added to `AuthUITests`.

## MOBILE-AUTH-10 — Integration, regression proof, and handoff

**Dependencies:** 01–09. **Deliverable:** Actual validation report distinguishing local implementation from live provider/deployment proof.

**Create:** `docs/testing/mobile-auth/validation.md`; extend auth test fixtures in native test directories as needed.
**Modify:** `README.md`, `android/README.md`, `ios/README.md`, and [task tracker](../../tasks/mobile-auth.md); adapt `ios/VocalUITests/VocalUITests.swift` test composition for authenticated fixtures without changing audio assertions.

- [ ] Exercise isolated Firebase emulator plus the existing local backend: register/login → bootstrap → restore → link password where supported → refresh profile → register/list installations → request verification/reset using emulator OOB actions → global revoke → old session rejected → fresh login succeeds.
- [ ] Use the backend's existing isolated-service helper for demo fixtures where applicable; any new integration harness must be test-only, own/clean up its processes and temporary data, and never use ambient production credentials. Do not change backend production logic to accommodate a test.
- [ ] Run all Android unit tests/lint/assembly and all iOS unit/offline UI tests on the single authorized simulator. Confirm existing local download/history/playback tests still pass with the auth gate supplied by test composition.
- [ ] Format changed Kotlin consistently with existing four-space style using available ktfmt tooling after checking its installed usage; format/lint changed Swift with `xcrun swift-format`. Do not mass-format unrelated source.
- [ ] Build Release variants without publishing to verify DEBUG fixtures/emulator switches are excluded. Validate Android resolved Firebase/Auth dependencies and iOS SPM resolution. Unsigned builds do not prove distribution signing.
- [ ] Inspect the diff and all newly created auth files, verify resource key parity, no credentials/tokens in logs or source, no password persistence, no real-data cleanup, and no audio behavior changes.
- [ ] Record actual command results, test counts, SDK versions, endpoint configuration, and unresolved live-provider/mailbox/signing/Android-device limitations. Do not claim skipped checks passed.
- [ ] Mark current auth tasks complete only when their acceptance evidence exists; keep account deletion as the next separate design/implementation task.

## Shared validation commands

Run Android commands from `android/`:

```sh
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
./gradlew :app:assembleRelease
```

Run iOS commands from `ios/`. Add each task's `-only-testing:` filters before the final `test` action when running focused tests:

```sh
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  test CODE_SIGNING_ALLOWED=NO

xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -configuration Release \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  build CODE_SIGNING_ALLOWED=NO

xcrun swift-format lint --recursive Vocal VocalTests VocalUITests
```

Android Release signing may be unavailable without reading private properties/keystores; report that specific blocker rather than exposing or replacing them. Kotlin compilation and Android lint are not Android device/UI proof. If the designated iOS simulator is unavailable, stop device execution rather than selecting another destination.

## Review and execution boundary

This plan was approved and executed with the testing changes recorded above. Consult the validation report for results; proposed commands and unchecked original test steps are not evidence that those commands ran. No commit, push, deployment, publication, live-account creation, or live mail transmission was performed during this implementation.
