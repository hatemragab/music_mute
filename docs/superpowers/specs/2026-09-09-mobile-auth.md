# Native mobile authentication design

Status: Approved and implemented locally on 2026-09-09. See the [execution evidence](../../validation/mobile-auth-2026-09-09.md) for actual checks and remaining live-provider limits.

## Confirmed scope

- Require sign-in before entering the Android or iOS app; no guest entry.
- Android: email/password registration and login, plus Google sign-in.
- iOS: email/password registration and login, plus Sign in with Apple.
- Allow explicit linking of email/password and the platform's social provider to the existing Firebase user.
- Allow unlinking only after reauthentication and when a usable sign-in method remains.
- Email verification remains optional initially; users can request it themselves.
- Support password recovery, persistent Firebase sessions, backend profile and installation synchronization, local logout, and logout from all devices.
- Preserve current local audio downloading, history, playback, and export behavior. Do not partition audio by account, migrate files, upload, or sync audio with the backend.
- Account deletion is a separate follow-up after this work. No deletion button or partial Firebase-only deletion in this release.
- Keep native Kotlin/Compose and Swift/SwiftUI, English/Arabic, RTL, existing themes, and accessible text sizes.
- Do not commit, push, publish, deploy, change live provider settings, create live test accounts, or send test mail without applicable user authorization.

## Current code and backend contract

At design time, both native apps used `com.hatem.musicmute` in Firebase project `music-mute`, with Firebase initialization but no authentication UI or session coordinator. The implementation now adds FirebaseAuth and native account flows at those composition roots.

Android composition lives in `VocalApplication`, `MainActivity`, and `ui/VocalApp.kt`, with ViewModels and repositories. iOS composition lives in `VocalApp.swift`, with observable state objects and service boundaries. Auth will be composed at these roots without rewriting audio state or persistence.

The source of truth for HTTP is [the backend auth contract](../../../backend/docs/auth-api.md). Its implementation is already present; this task consumes it and does not invent server endpoints.

| API under `/api/v1` | Client responsibility |
| --- | --- |
| `POST /auth/session` | Bootstrap with installation report after Firebase authentication; receive user, device, policy, and processing access. |
| `POST /auth/profile-sync` | Refresh authoritative backend profile after verification, linking, or unlinking. |
| `GET /users/me` | Refresh safe account details and validate a restored session. |
| `GET /users/me/devices` | Show registered installations, with cursor pagination. This is not a list of individually revocable sessions. |
| `PUT /users/me/devices/:installationId` | Report changed app/OS metadata. |
| `GET /app-policy` | Read verification/version policy. |
| `POST /auth/verification-email` | Request verification voluntarily, honoring server cooldowns. |
| `POST /auth/password-reset` | Request recovery with generic account-existence-neutral feedback. |
| `POST /auth/logout-all` | Revoke all sessions, then sign out locally. |

Firebase owns credentials and refresh tokens. HTTP receives only Firebase ID tokens in Authorization headers. Google access tokens, Apple authorization codes, passwords, private keys, and client-selected UIDs are not backend auth inputs.

## Approach and alternatives

Use official native Firebase Auth SDKs, a small platform-specific identity adapter, a typed backend client, and an app-owned session coordinator. Compose and SwiftUI screens observe the coordinator and call actions, never perform HTTP or provider authentication directly.

FirebaseUI could shorten the initial login form work, but custom screens fit the existing bilingual UI and the required backend bootstrap, provider management, and mail limits. A custom JWT or password implementation would duplicate Firebase responsibilities and is excluded.

### Dependency baseline

| Platform | Selection | Reason |
| --- | --- | --- |
| Android | Existing Firebase BoM `34.18.0`, add `firebase-auth` | Keep Firebase libraries aligned with the existing project. |
| Android | `androidx.credentials:credentials:1.6.0` and `credentials-play-services-auth:1.6.0` | Stable Credential Manager release; do not copy alpha versions from documentation examples. |
| Android | `com.google.android.libraries.identity.googleid:googleid:1.2.0` | Released Google ID library for Credential Manager. |
| Android | Existing coroutines, Kotlin serialization, DataStore | Reuse state, JSON, and persistence dependencies. Use an injectable `HttpURLConnection` transport on `Dispatchers.IO`, with cancellation closing the connection. |
| iOS | Existing Firebase SPM pin `12.18.0`, add FirebaseAuth product | Extend the current Firebase package without a second dependency manager. |
| iOS | System `AuthenticationServices`, `CryptoKit`, `URLSession` | Native Apple sign-in, nonce hashing, and HTTP; no third-party Apple wrapper needed. |

These are selected stable versions, not a claim that integration has already compiled. Resolve and inspect exact dependency graphs during implementation; reject prerelease substitutions and record any compatibility-driven change.

## Session lifecycle

States: restoring, signed out, authenticating, bootstrapping, authenticated, and blocked. Authenticated state includes online/offline status and whether profile synchronization is pending. Form loading and provider prompts are action state, not extra global sessions.

1. Firebase restores its own session. No Firebase user means the login screen, without displaying app content first.
2. A new registration or sign-in requires successful backend bootstrap before first entry. Firebase success followed by backend failure shows a retry/sign-out screen; it does not create another Firebase account on retry.
3. Persist only a small successful-bootstrap record scoped to Firebase UID, plus installation state. The record contains no bearer or refresh token and cannot open the app without a matching restored Firebase user.
4. Approved offline behavior: a previously bootstrapped, matching Firebase session may reopen local functionality during connectivity failure. New accounts, a changed UID, explicit logout, or known invalid/disabled sessions never use this fallback. Remote revocation is discovered on the next successful online check.
5. Validate restored sessions on launch and coalesced foreground entry. Do not bootstrap on each token event, recomposition, or navigation. Concurrent token refreshes and bootstrap requests share one in-flight operation.
6. SDK token requests normally use cached/automatically refreshed ID tokens. An HTTP 401 permits one forced refresh and one replay only for safe profile/device/session operations. A second 401 ends the local session. Mail and logout-all are never automatically replayed.
7. Each auth transition increments a generation. Late token, network, or provider results from an older generation cannot restore a signed-out session or populate a different user's account UI.
8. On local sign-out, close the app gate immediately, clear account/profile caches and the bootstrap record, sign out of Firebase, and clear Credential Manager session state on Android. Do not remove installation identity or local audio. Existing local background audio work retains its current behavior.
9. Logout-all requires connectivity and explicit confirmation. A 204 confirms all-session revocation. A transport error or 503 has an uncertain outcome: show that global logout was not confirmed, sign out locally, and do not silently schedule or replay revocation.

Keep password/credential form values only in memory. Do not place them in saved-state persistence, logs, analytics, crash breadcrumbs, screenshots attached to reports, or backend error messages.

## Screens and actions

- Login: email/password, platform social button, create-account link, forgot-password link, accessible errors, password visibility/autofill, and language/theme continuity.
- Registration: email/password/confirmation with Firebase policy validation; do not invent a display-name field because the backend derives the account name.
- Recovery: generic accepted message and server-controlled cooldown; returning to login is always available.
- Bootstrap recovery: retry backend setup or sign out; distinguish connectivity from bad credentials.
- Settings account section: backend display name, email, verification status, linked methods, registered devices, local logout, and logout-all.
- Verification: request on tap, then an explicit 'I have verified' refresh and a coalesced refresh when returning from the browser. Reload Firebase user, force-refresh ID token, then synchronize profile. No automatic verification email at registration.
- Linked methods: indicate which methods are available on this platform, add email/password, link Google on Android or Apple on iOS, and safe unlinking. Both platforms display all linked provider IDs returned by the account; neither adds the other platform's provider flow.
- Registered devices: show current installation, app/OS metadata and last seen, paginated; no individual device removal or revocation controls.

Provider cancellation is a neutral return to the current screen. Handle offline, credential mismatch, disabled account, credential collision, missing provider configuration, SDK throttling, and backend throttling with safe localized messages. Retain a typed internal category without surfacing raw SDK payloads.

## Linking and unlinking

Link credentials to the currently authenticated Firebase user; do not sign in with the new provider as a substitute for linking. Reauthenticate the existing account first, serialize mutations, and compare the UID before accepting results. Successful linking preserves that UID. Reload Firebase state, refresh the ID token, and synchronize the backend; if only synchronization fails, show the actual Firebase result and a retryable pending-sync notice rather than repeating the link operation.

Adding email/password uses the Firebase account's current email, displayed explicitly. For Apple relay addresses, explain that this is the email used for password login and recovery. Do not silently replace the primary email; email-address changes are outside this scope. If Firebase supplies no usable email, explain why password linking cannot proceed rather than inventing one. Obtain explicit consent when linking Apple identity with other account data.

If a credential belongs to another Firebase UID, retain the current session and show that the user must sign in to the owning account. Never merge two backend accounts by matching email, delete either account, or transfer data. For sign-in provider conflicts, offer the existing login screen without enumerating an email's available methods. Credentials pending any collision recovery remain memory-only and are discarded on cancel or session change.

Before unlinking, reload the provider list and require another method usable on the current platform. Reauthenticate using a method that will remain, confirm the consequence, then unlink. Example: Android cannot remove Google when the only remaining method is Apple; add email/password first. Explain that signing in later with a removed provider can create a separate account; relink from the original account to reuse it. Display providers available on the other platform, but manage that social provider on its own platform.

The client checks and serializes its own mutations; this is not a global atomic lock across devices or the Firebase console. Test concurrent refresh/cancel behavior and report this Firebase-managed limitation rather than claiming a server-enforced last-provider invariant.

## Provider specifics

Google: use an explicit Credential Manager sign-in button, the Web OAuth client ID from the public Firebase client configuration, and only the identity scopes needed by Firebase. Correctly handle no credentials, cancellation, wrong credential types, and activity recreation. Reauthentication must prove the same Firebase UID. Debug and distribution signing fingerprints must be checked independently.

Apple: generate a cryptographically random nonce for each attempt, send its SHA-256 digest to Apple, and send the original nonce plus Apple ID token to Firebase. Request only name/email, tolerate their absence on subsequent authorizations, and use Firebase's credential result without inventing user details. Keep authorization codes and nonces memory-only. Configure Sign in with Apple entitlement and handle credential revocation/account switch. A fresh Apple credential is needed for each new action; do not reuse a consumed credential or blindly retry it.

## Installation and HTTP behavior

Persist one lowercase random UUID v4 for this installation, independent of account identity. Use app-private storage excluded from backup/restore: Android's no-backup directory and an iOS Application Support record excluded from backup. Do not use advertising IDs, serial numbers, device names, or phone numbers. Reinstall creates a new installation identity; guard against iOS Keychain restoring a stale auth session without a matching successful-bootstrap record.

Persist the metadata snapshot and revision atomically before sending. Identical retries use the same revision; metadata changes increment it, including version downgrades. Fields: platform, appVersion (1–32 characters), positive buildNumber up to 2147483647, positive metadataRevision up to 9007199254740991, osVersion (1–64), optional deviceModel (1–100), with control/format characters excluded. Use generic model identifiers, not user-assigned names. Release builds require a valid numeric build value; do not silently report a fabricated version.

On device-report conflict, fetch the current owner's registered installations using bounded pagination, find this installation, and reconcile once above the server revision if necessary. Do not reset the UUID or loop indefinitely. Losing local installation state creates a new installation; it never overwrites another owner's record.

Use a validated build-configured API base URL, HTTPS in release, no embedded Admin credentials, and no bearer forwarding across redirects. Debug tests may use explicit loopback HTTP exceptions that are absent in release. Use finite connect/read/request deadlines (15 seconds), bounded response size (1 MiB), typed DTO decoding, and cancellation. Android uses `Long` for metadataRevision; Swift uses `Int64` with the backend safe-integer bound.

Handle `PROFILE_SYNC_REQUIRED` with one coordinated bootstrap before retrying a safe read. Honor valid `Retry-After` for 429; use a conservative 60-second wait if absent/invalid. Mail success also starts the documented 60-second cooldown. Do not run retry timers that send mail automatically. 403 account-disabled closes the app gate; 503 or malformed responses are service failures, not invalid passwords. Do not attach bearer tokens to password-reset or public-policy requests.

Store and present server processing-access decisions separately from authentication. The backend currently applies verification/minimum-build restrictions to future processing, not auth recovery or local audio. Do not turn an `access.allowed=false` bootstrap result into a sign-in failure, block existing local audio, or introduce processing calls. Account UI can explain verification/update requirements and open a validated credential-free HTTPS update URL on user action.

## Configuration and evidence boundaries

Repository public documentation inspected for this plan does not provide a confirmed deployed API origin. Add explicit configuration and validate it; never invent a host or commit a placeholder as a production endpoint. Emulator integration and local builds can proceed while the deployment origin is being verified from authorized deployment state. Ask for the origin only if it cannot be established there.

The existing client Firebase files and signing documentation do not prove Google or Apple login works. During implementation verify provider enablement, Web client ID, Android debug/release fingerprints, Apple team/bundle entitlement, and private email relay configuration through available authorized read-only access. Record readiness separately from app compilation. No service-account key belongs in a mobile artifact.

The user's subsequent implementation instruction superseded the original simulator restriction for this task: runtime/UI checks use only the connected Android device `$ANDROID_DEVICE_SERIAL`, with direct ADB interaction. No Maestro, Android emulator, or iOS runtime tests. Both platforms still receive appropriate build/static checks, with a small focused Android test addition.

Use an isolated Firebase Auth emulator with `demo-` project IDs for account-creating automation. Real Google/Apple prompts and live verification/reset mailbox delivery need separate evidence and authorized accounts; emulator success is not proof of those flows. Debug test injection must be absent from Release and must never bypass production auth through a launch argument.

## Acceptance

1. Signed-out launch cannot enter any tab; matching restored sessions have the lifecycle described above.
2. Registration, email login, native provider adapters, recovery, voluntary verification, linking, unlinking, account/devices UI, and both logout actions have meaningful success/error/cancellation tests.
3. Backend bootstrap, ID-token authentication, device revisions, refresh coalescing, stale-result protection, and quota handling use the actual contract.
4. Password linking and each available provider preserve UID; collisions never merge accounts and last-usable-provider removal is blocked by the client.
5. Existing audio tests remain valid, with only test composition adapted for the new auth gate; no audio behavior or data migration is introduced.
6. Android compile/lint/JVM tests and iOS format/build checks have actual recorded results. iOS runtime tests were excluded by the later execution instruction. Live provider, signing, mailbox, and deployed-backend evidence remain separately labeled.

## Primary sources checked 2026-09-09

- [Firebase Google sign-in on Android](https://firebase.google.com/docs/auth/android/google-signin): SDK integration and OAuth configuration.
- [AndroidX Credentials releases](https://developer.android.com/jetpack/androidx/releases/credentials): stable 1.6.0 selection.
- [Google ID release notes](https://developers.google.com/identity/android-credential-manager/releases): 1.2.0 release.
- [Firebase Apple authentication](https://firebase.google.com/docs/auth/ios/apple): native provider, nonce, consent, and relay requirements.
- [Android account linking](https://firebase.google.com/docs/auth/android/account-linking) and [Apple-platform account linking](https://firebase.google.com/docs/auth/ios/account-linking): same-UID linking, collisions, and unlink behavior. The Android page flags a project-dependent linking issue; include a real-project linking check before claiming live readiness rather than silently implementing an unsupported workaround.
