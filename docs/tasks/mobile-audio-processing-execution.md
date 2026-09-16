# Mobile audio processing execution ledger

Started 2026-09-10. Goal: implement both approved native mobile plans and MOB-B01.

## Decisions

- Ruling: work in the current checkout on codex/backend-auth-users-devices — the user requests work directly here and the current native/backend sources are untracked alongside preserved legacy deletions. Moving to a clean worktree would omit the actual baseline. No commits, pushes, deployment or unrelated restoration.
- Ruling: retain the mobile implementation scope while separating local validation from external runtime gates. Android device testing is unavailable under the iPhone-only restriction; JVM/lint/build still run. Live S3/FCM/APNs evidence requires its own environment and is never inferred from fixtures.
- Ruling: use separate task agents for independent platform contracts and notification changes as required by the execution skill; root owns integration and final verification.

## Current tasks

- MOB-B01 complete locally: privacy-safe visible ready/failed notifications preserve the durable outbox and data keys. No live provider send was used for validation.
- MOB-B02 complete locally: backward-compatible expectedBindingRevision on push deactivation prevents stale cleanup from disabling a newer binding; both mobile clients send the acknowledged revision and fence authentication epochs.
- A01–A07 integrated. A08 local JVM/lint/APK validation passes; Android runtime UI remains outside the authorized target restriction.
- I01–I08 integrated. Final simulator run passed 100 unit/7 UI tests, with 2 live opt-ins skipped; latest-source unsigned Release build passed.
- Production demo entry points now route to explicit processing. Saved originals remain local; imports and original files are immutable inputs. Voice-only MP3 output is fetched only on explicit result actions.

## Review corrections

- Both history controllers retain visibility intent across delayed owner binding and reauthentication, preventing a visible screen from silently losing polling.
- Both notification parsers accept the actual backend colon-delimited event IDs. Fixture payloads now use that format.
- iOS production dependencies are retained in a single lazy StateObject graph, avoiding delegate replacement with a discarded SwiftUI initialization graph. Initial push selection opens detail even before the tab view is first constructed.
- Push registration waits for an online authenticated/bootstrap state; cached private history remains usable offline.
- Cancellation persistence and API token refresh re-check the captured authentication epoch before proceeding. Old responses cannot recapture a new account.

## Validation notes

- Initial Android invocation could not find the SDK. Set `ANDROID_HOME` to the
  local Android SDK path for subsequent commands; no local configuration file
  changed.
- Test-first compilation/runtime failures were observed before implementing contracts and race fixes; final pass counts below supersede those intermediate failures.
- The exact authorized iOS simulator was found by the iOS task agent; no alternate device selected.
- Backend final `npm run verify`: formatting, lint, typecheck, 342 unit tests, 35 HTTP tests and build passed. `node --test test/push-registrations.integration.mjs test/notifications.integration.mjs`: 9 isolated tests passed.
- Android final reviewed run `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug`: 105 tests passed, lint zero errors/27 warnings, APK assembled. No Android device run.
- iOS final combined suite: 100 unit tests and 7 UI tests passed; 2 live-network opt-ins skipped. This includes native synthetic MP3 playback/seek, Save picker opening/dismissal, seeded-original processing through fixture upload completion, Arabic large text and offline cache/relaunch.
- iOS stale-session cleanup now uses captured transfer IDs after task enumeration, so a delayed cleanup cannot cancel a replacement transfer for the same owner/operation. Both race regressions pass.
- iOS generic unsigned Release build passed. Only Firebase FCM-token deprecation and AppIntents metadata warnings; no device run or signing changes.
- Final latest-source Release rebuild includes both polling/session cleanup fixes and passed (`/tmp/vocal-processing-release-final.log`). Recursive strict Swift lint passed with zero findings, and `git diff --check` passed. Independent integration reviews are closed.

Validation reports: [Android](../validation/mobile-processing-android.md), [iOS](../validation/mobile-processing-ios.md).
