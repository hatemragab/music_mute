# Android UI/UX audit — 13 September 2026

Implementation is isolated in `.worktrees/full-app-ui-ux-audit` on
`ui-ux/full-app-audit`, based on fetched remote `main` at `141aad0d`.
The original dirty checkout was preserved. Nothing was pushed or deployed.

## Screens audited

This is a complete **source-level** inventory and review. Android runtime/UI
verification is unavailable under the user's iPhone-only device restriction.
The entries below must not be interpreted as visual or device test results.

| Surface                                       | States reviewed and resulting treatment                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MainActivity and app shell                    | Edge-to-edge bars, navigation rail/bottom bar, notification entry, saved navigation and keyboard insets. Removed duplicate rail system insets.                                                                     |
| Auth restoration                              | Added text beside the restoration spinner.                                                                                                                                                                         |
| Backend bootstrap                             | Retry shows busy state; sign-out is disabled during the request.                                                                                                                                                   |
| Login                                         | Email, password visibility, Google handoff, unavailable configuration, offline/error/busy states; benefits from shared IME and feedback fixes.                                                                     |
| Registration                                  | Name, email, passwords, confirmation mismatch, disabled submit and Google registration; sensitive fields remain unsaved.                                                                                           |
| Password reset                                | Email validation, resend cooldown, success/error and back navigation; shared keyboard/feedback treatment.                                                                                                          |
| Profile/account                               | Offline identity, pending name sync, verification, policy, sign-out and public links; retained behavior with accessible header and disabled action styling.                                                        |
| Email verification sheet                      | Resend cooldown, checking and errors; prevents dismissal during a request.                                                                                                                                         |
| Sign out everywhere sheet                     | Confirmation, busy/error and cancellation; prevents busy dismissal.                                                                                                                                                |
| Linked methods list                           | Connected/unconnected/last-method/Apple-only management; placed action below provider details to avoid squeezing long labels.                                                                                      |
| Add password and Google-link reauthentication | Password confirmation, provider handoff, errors and busy states; shared keyboard/accessibility fixes.                                                                                                              |
| Unlink method sheet                           | Retained-method reauthentication and busy/error states; protects busy dismissal.                                                                                                                                   |
| Registered devices                            | Current/other devices, long names, pagination, empty/offline/error; removed double card padding.                                                                                                                   |
| Account deletion review                       | Disclosure, password/Google reauthentication and errors; preserves fresh consent and sensitive state handling.                                                                                                     |
| Final deletion dialog                         | Confirmation, error and busy states; content now scrolls for large text/long messages.                                                                                                                             |
| Account recovery                              | Form, pending/rejected/expired/unknown decision and refresh; constrained multiline field, weighted timeline text and busy button.                                                                                  |
| Home                                          | Import, secondary YouTube entry, zero/many jobs, loading, preparation, failures and pagination; unified spacing and avoided contradictory empty/loading/error displays.                                            |
| Notification permission entry                 | Added the existing optional-permission explanation; denial does not block processing. OS prompt remains system-owned.                                                                                              |
| YouTube link sheet                            | Blank/invalid/pasted URL and busy states; invalid action disabled and busy dismissal blocked.                                                                                                                      |
| YouTube rights confirmation                   | Long URL/disclosure and busy state; one labelled checkbox target including its text.                                                                                                                               |
| Local import review                           | Filename, metadata, rights, errors and busy state; wrapping metadata and retry after a failed submission. Consent is still mandatory and deliberately not saved.                                                   |
| Source download/preparation detail            | Progress, review, cancellation, retry, source failure and missing-source fallback; accessible timeline states.                                                                                                     |
| Processing detail                             | Waiting, uploading, queue, validation, processing, interruption, cancellation, retry, processing unavailable, failed/missing job and result retrieval; explicit loading/unavailable feedback and wrapping actions. |
| Completed result                              | Play/download/save/share remain explicit; moved completed timeline after result actions so it no longer precedes the main task.                                                                                    |
| Processing timeline/task cards                | Completed/current/incomplete semantics; wrapping legacy actions, filename ellipsis, cancellation suppression while cancelling.                                                                                     |
| Legacy processing history                     | Reviewed even though it is not in the current NavHost; constrained width, shared spacing, wrapping actions and truthful empty/pagination states.                                                                   |
| Legacy original-download history              | Completed/queued/downloading/failed/cancelled records, original playback and export; consistent page tokens, guarded seek and bounded progress.                                                                    |
| Library                                       | Empty/single/many items, search/filter/sort, errors and offline downloads; centered width constraint, keyboard viewport, uncluttered track titles and no error-as-empty message.                                   |
| Library action sheet                          | Download/hide/restore/details and download-in-progress; avoids duplicate download action while already downloading.                                                                                                |
| Track information                             | Media/job tabs, long title, missing/cached metadata, save/share; more title space, stacked export actions and localized backend status labels.                                                                     |
| Rename sheet                                  | Invalid/unchanged/long name, busy/error/success; wrapping actions, protected busy dismissal and restoration-aware success dismissal.                                                                               |
| Delete audio sheet                            | Disclosure, busy/error/confirm/cancel; protected busy dismissal.                                                                                                                                                   |
| Full player                                   | Empty/missing track, long title, buffering/failure, playing/paused, seek, shuffle/repeat/auto-next/up-next; primary controls fit small phones, secondary actions wrap, explicit empty state and guarded seek.      |
| Mini-player                                   | Long/missing title, loading, failure and paused/playing; visible failure instead of a stale progress bar and title fallback. Pause remains available during buffering.                                             |
| Playback queue sheet                          | Empty/many/current/removed tracks, offline status and playback modes; capped lazy viewport, bounded titles and duration under metadata.                                                                            |
| Settings/language                             | Loading/error/disabled preference selection and navigation; disabled radio/text styling matches availability.                                                                                                      |
| Accent picker                                 | Presets/custom invalid input/reset/preview; fewer columns for narrow or large-text layouts, reset from the canonical constant, preview sample no longer a dead interactive button.                                 |
| About                                         | Version, import/process/offline disclosures and configured public links; existing shared page is retained.                                                                                                         |
| Update gate                                   | Restoration, required/optional prompt, download, verification, permission, installer/store handoff and failures; proportional optional-banner height, wrapping actions and error feedback.                         |
| External system surfaces                      | Document import/export, share chooser, notifications, Credential Manager and installer: inspected launch/callback boundaries. Their UI is owned by Android/providers and was not redesigned.                       |

No separate onboarding, subscription, paywall, Fragment or XML-layout UI was found.
Login is the entry experience. Preview-only components were also inspected.

## Issues fixed by category

| Category            | Changes                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Layout              | Keyboard reduces the scroll viewport; removed duplicated device padding and rail insets; result actions precede the long completion timeline.                                              |
| Responsiveness      | Player controls, consent metadata, rename/processing/update actions, linked methods and accent presets adapt to available width or font scale.                                             |
| Typography          | Kept Material/Creative hierarchy; bounded list titles with ellipsis while keeping detail titles readable; replaced raw job status codes with existing localized copy.                      |
| Colors/theme        | Preserved the intentional dark Creative theme and contrast-adjusted accent palette; made disabled states and playback/update failures explicit.                                            |
| Components          | Shared consent row, feedback live regions, header semantics, busy-aware sheet dismissal and common player presentation helpers.                                                            |
| Navigation          | Account page state is saved in the authenticated owner scope; rename dialog restoration no longer immediately dismisses a restored edit; existing primary destinations retained.           |
| Audio workflow      | Retry remains available after import submission failure; seek requires available nonfailed/nonbuffering audio; result retrieval remains user-triggered.                                    |
| Loading/error/empty | Avoided conflicting empty/error states, labelled preparation/restoration, exposed missing detail and mini-player failures, cleared stale library action errors on refresh.                 |
| Accessibility       | Consent text and checkbox form one 48dp-minimum labelled target; headings and timeline status semantics; polite error/notice announcements; descriptive existing player controls retained. |
| System UI           | IME viewport and consumed-inset handling, scrollable confirmation, busy sheet gesture protection and proportional update banner.                                                           |
| Code quality        | Extended the existing token set and motion constants instead of introducing a second system; shared playback progress/seek policy; added reusable stress preview configurations.           |

## Shared components and design tokens

- Added `CreativeConsentRow`, used by local import and YouTube consent.
- Refined `CreativePage`, `CreativeSheet`, `CreativeHeader`, `CreativeFeedback`,
  `CreativePrimaryButton`, `AccountHeader` and `AccountActionRow`.
- Added shared `PlaybackState.canSeekAudio()` and `playbackProgress()` presentation
  helpers for voice/original playback and progress bounds.
- Extended `CreativeTokens` with progress sizing, player/artwork/queue sizing and
  disabled alpha; reused existing page/card/spacing/content-width/touch tokens.
- Added `CreativeMotion.PRESS_MS`; theme colors, typography and radii continue to
  use the existing centralized `Theme.kt` and `AccentPalette`.
- No dependencies, processing algorithms, network contracts, database schemas,
  authentication policy or release configuration were changed.

## Verification

Final command, run with JDK 17 and the installed Android SDK:

```sh
cd android
./gradlew clean :app:assembleDirectDebug :app:assemblePlayDebug \
  :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest \
  :app:lintDirectDebug :app:lintPlayDebug
```

| Check           | Direct Debug                            | Play Debug                              |
| --------------- | --------------------------------------- | --------------------------------------- |
| Clean build     | PASS                                    | PASS                                    |
| JVM tests       | PASS — 226 tests, 0 failures, 0 skipped | PASS — 206 tests, 0 failures, 0 skipped |
| Lint            | PASS — 0 errors, 131 warnings           | PASS — 0 errors, 113 warnings           |
| Device/UI tests | NOT RUN — device restriction            | NOT RUN — device restriction            |

Final combined command exited 0 (`BUILD SUCCESSFUL in 42s`). `git diff --check`
also passed. Lint warnings include unused resources, dependency-update suggestions,
KTX suggestions, storage API and package-query warnings; they were not all removed
as part of this UI scope. No claim is made that these warning counts are unchanged
from baseline. Reports are in `android/app/build/reports/`; APKs are in
`android/app/build/outputs/apk/{direct,play}/debug/`.

The seek regression was observed failing with the original duration-only rule,
then passed with the fix. Existing test suites were run at several checkpoints.
Independent source review found two regressions, both corrected and rechecked:
Pause remains available during buffering, and saved account navigation is consumed
only after authentication restores the owning identity.

`AuditPreviews.kt` adds 40 configurations across eight fixtures: small phone,
landscape, large phone, 200% Arabic text and light-system mode with the intentional
dark Creative theme. They cover long/missing titles, one/many tracks, playback
failure, offline Home, a long import error and accent selection. Preview compilation
does not prove rendering, contrast or actual touch geometry.

## Remaining limitations

- Android device/UI tests, TalkBack, actual IME/cutout geometry, picker/provider
  handoffs and authenticated navigation could not run under the iPhone-only rule.
- Actual offline/timeouts/permissions/audio decode failures, background completion,
  process death and playback restoration still require authorized Android runtime
  validation. Source review, preview fixtures and JVM tests do not establish those.
- The existing design supports a dark theme only. No new light theme was invented.
- Nonfatal lint warnings remain and are reported with the final counts. There is
  no configured Kotlin formatter task; diff whitespace and Android lint are checked.
- Release signing, production services and store publication are outside this UI
  audit. Debug APK assembly is not release or live backend proof.

The original checkout's unrelated work was neither stashed nor reset. The ignored
Firebase configuration symlink exists only to build this isolated worktree; its
contents were not printed or committed.

## Git and main files

Branch: `ui-ux/full-app-audit`. Five logical commits, 37 changed files relative to
the fetched main baseline:

1. `c8d50e60` — `refactor(ui): improve shared layout and accessibility foundations`
2. `32998460` — `fix(ui): improve import processing and history edge states`
3. `cab300ce` — `fix(ui): improve player and library responsiveness`
4. `e452071f` — `fix(ui): refine account settings and system interactions`
5. Final HEAD — `refactor(ui): finish audit verification and regression cleanup`

Main implementation locations under `android/app/src/main/java/com/hatem/musicmute/`:

- `ui/design/CreativeComponents.kt`, `CreativeTokens.kt`, `CreativeMotion.kt`:
  shared UI foundations.
- `ui/home/`, `ui/importing/`, `ui/ProcessingDetailScreen.kt`,
  `ui/AudioStepTimeline.kt`, `ui/jobs/SourceDownloadDetailScreen.kt`: audio workflow.
- `ui/player/`, `ui/library/`, `ui/DownloadHistoryScreen.kt`: playback and library.
- `ui/auth/`, `ui/settings/`, `ui/VocalApp.kt`, `updates/UpdateGate.kt`: account,
  preferences, navigation and system UI.
- `ui/AuditPreviews.kt`, localized `res/values*/ui_audit.xml`, and
  `src/test/java/com/hatem/musicmute/ui/player/PlaybackPresentationTest.kt`:
  preview coverage, accessibility copy and regression checks.

The source inventory and execution checklist are in
`docs/superpowers/plans/2026-09-13-android-ui-audit.md`.
