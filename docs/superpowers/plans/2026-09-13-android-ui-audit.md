# Android UI audit and implementation

Goal: refine every Android UI surface on `ui-ux/full-app-audit`, based on remote
main `141aad0d`, while retaining the Creative dark theme, orange/custom accent,
three primary destinations, consent boundaries, and existing processing behavior.

Architecture: use the existing Compose Material 3 components and Creative tokens.
Keep processing, persistence, authentication, networking and update enforcement
unchanged. Build after each screen group; commit independently reviewable groups.

## Inventory and checklist (created before source changes)

Each entry includes all of its loading, empty, error, busy and navigation states.
Checked entries mean source review and applicable implementation are complete;
they do not mean Android runtime verification.

- [ ] Shared Creative page, sheet, card, buttons, fields, feedback, wave, navigation
- [ ] Theme, accent contrast, typography, motion and reduced-motion behavior
- [ ] MainActivity, system bars, Scaffold, bottom navigation and wide navigation rail
- [ ] Authentication restoration and backend bootstrap
- [ ] Login
- [ ] Registration and password confirmation
- [ ] Password reset and resend cooldown
- [ ] Profile/account, offline status and public links
- [ ] Email verification sheet and cooldown
- [ ] Sign out everywhere sheet
- [ ] Linked methods list
- [ ] Add password and link Google reauthentication forms
- [ ] Unlink method confirmation sheet
- [ ] Registered devices, pagination and empty/error states
- [ ] Account deletion review and reauthentication
- [ ] Final account deletion dialog
- [ ] Account recovery form, pending, rejected, expired and unknown decision
- [ ] Home/import entry, task list, pagination and notification permission entry
- [ ] YouTube link sheet, clipboard and invalid URL
- [ ] YouTube rights confirmation
- [ ] Import review, rights confirmation and submission failure
- [ ] Source download/preparation detail and missing-source fallback
- [ ] Processing detail: waiting, transfer, queue, validation, processing, result
- [ ] Cancellation, retry, interruption, worker offline and unavailable result
- [ ] Completed result: explicit play, download, save and share
- [ ] Processing timeline and task cards
- [ ] Legacy processing-history composable (not a current navigation destination)
- [ ] Legacy download history destination and original-audio controls
- [ ] Library, search, filters, sort, empty/error and download states
- [ ] Library item action sheet, hide and restore
- [ ] Track information, media and job tabs, missing/cached metadata
- [ ] Rename sheet and validation
- [ ] Delete audio sheet and busy/error states
- [ ] Full player: empty, buffering, failure, playing, paused, seeking and queue modes
- [ ] Mini-player
- [ ] Playback queue sheet and empty/removal states
- [ ] Settings, language persistence and preference failure
- [ ] Accent presets, custom validation and preview
- [ ] About and configured public links
- [ ] Update restoration, required update, optional banner, download/verify/install failures
- [ ] External document picker, export/share chooser, notification permission,
      Credential Manager and installer handoffs (owned by Android/provider UI)
- [ ] Final app-wide comparison and clean build

No separate onboarding, paywall, subscription, Fragment or XML-layout screens were
found. Login acts as the entry experience. The source scan includes the legacy
composables and the update gate outside `ui/`.

## Implementation order

1. Shared foundations: correct IME viewport handling; shared consent row; accessible
   feedback/headings and consistent sizing. Compile Direct Debug.
2. Home/import/source/processing/results and legacy screens: truthful loading/error
   presentation, accessible stage semantics, wrapping action rows. Compile and test.
3. Library/player/queue/details/rename/delete: responsive controls, title handling,
   keyboard behavior, state restoration and localized job status. Compile and test.
4. Auth/account/devices/overlays/settings/update gate: action wrapping, spacing,
   busy visibility, navigation restoration and scrollable confirmation. Compile.
5. Add stress previews, review diff, run clean Direct and Play Debug assembly,
   JVM tests and Android lint. Record exact counts, limitations and commits.

## Verification constraints

Baseline `:app:assembleDirectDebug :app:testDirectDebugUnitTest`: PASS.
JDK 17 and SDK 36 are available. Ignored Firebase configuration is linked from the
original checkout without reading, changing or committing its contents.
Android device/UI tests cannot run under the user's iPhone-only device rule.
Small/landscape/large-font/Arabic previews can compile but must not be reported as
rendered or visually verified. Permission, background restoration and live backend
behavior require future authorized Android runtime validation.

The app intentionally uses a dark theme regardless of system theme; this audit
preserves that product decision. Light theme is not an existing supported mode.
