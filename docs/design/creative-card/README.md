# MusicMute Android Creative Card design review

Status: implementation authorized and in progress on 2026-09-13. The shared foundations and redesigned app routes are implemented locally. See the [implementation checkpoint](../../superpowers/plans/2026-09-12-android-creative-card/IMPLEMENTATION-STATUS.md) for validation and remaining acceptance.

Authoritative documents: [approved specification](ANDROID-REDESIGN-SPEC.md) and [shared-first implementation plan](../../superpowers/plans/2026-09-12-android-creative-card-redesign.md). They resolve the earlier review questions and define the later parallel screen-agent phase.

## Approved decisions

- Native Kotlin / Jetpack Compose, existing Media3 playback integration.
- Creative Card visual language; dark surfaces only, no light/system theme selector.
- Default preview accent orange #FF814A. User can select presets or any custom accent; picker A (Palette). Keep readable foreground contrast when generating palette.
- Shared reusable smooth flowing wave animation across screens; follows accent. Pause offscreen/background; respect disabled system animations. Mockups are static illustrations.
- Auth: cohesive Creative Card login, registration, password-reset board approved. Registration includes Full name, Email, Password, Confirm password. Earlier minimal auth selections were superseded.
- Home A (Compact): import and secondary YouTube entry, jobs instead of recent media, Load more inside job list.
- Library B (Audio cards): processed voice results only, search, filters, stars, mini-player. Completed entries appear automatically; retrieve complete audio on Play/Download/Share and retain it for fully offline playback after restart. Tap opens player; Info opens media/job details.
- Player A (Wave card): Media3 playback, seek, previous/next, queue, shuffle, repeat off/all/one, auto-next preference; repeat-one takes precedence. Background and system playback controls.
- Track details C (Media/Job tabs). Show the actual originating job; missing historical metadata gets an unavailable state, never invented information.
- Settings C (inline language choices), Profile FIRST item, then accent setting and language/about. No profile shortcut in other screen headers.
- Profile C (Compact), Login methods B (Simple list), Devices C (Grouped).
- Accent picker A (Palette), with presets and custom selection.
- Keep English/Arabic/RTL, responsive sizing, real loading/error/action states.

## Resolved product decisions and implementation boundaries

- Library contains only MusicMute processed voice results, not original imports or a phone-wide collection. Do not request whole-device media permissions.
- Audio only. The former video board 07 selection C is a compact audio-layout reference; no video page or video filter is approved.
- Existing delete-audio flow removes cloud/account and private copies. Keep it distinct from local Library hiding/restoration as defined in the specification.
- Durable complete files are mandatory for offline playback; buffered/partial audio is insufficient. Reuse the existing owner-scoped no-backup output storage and preserve security cleanup rules.
- All recommended A motion variants are approved; use shared controls and lifecycle-aware wave animation.
- Full name, favorites/search/filter, expanded queue/player UI and custom accents are requested changes, not claims that existing code already implements them.
- Do not fetch output merely to populate artwork/waveforms. Existing output retrieval stays action-triggered; decorative wave is not a measured audio waveform.
- State values, dates, names, versions and progress in images are illustrative. Never fabricate unavailable progress/timing in implementation.
- The redesigned About route describes source import, cloud processing and persistent offline results.

## Source inventory reviewed

- `android/app/src/main/java/com/hatem/musicmute/ui/VocalApp.kt`: routes, Home, import review and YouTube rights dialogs, Settings; legacy demo components also present.
- `ui/ProcessingDetailScreen.kt`, `ui/AudioStepTimeline.kt`, `ui/DownloadHistoryScreen.kt`: real task/history actions, timeline, rename/delete and source transfer states.
- `ui/auth/AuthScreen.kt`, `AccountScreen.kt`, `LinkedMethodsScreen.kt`, `DevicesScreen.kt`, `AccountRecoveryScreen.kt`: auth/account states and confirmations.
- `updates/UpdateGate.kt`: optional/required updates, progress, retry and installer states.
- `res/values/strings.xml`: exact disclosures and current behavior text.

## Approved review boards

Open [GALLERY.md](/Users/hatemragap/work_spaces/music_remover/docs/design/creative-card/GALLERY.md) for all 24 numbered comparison boards with recorded choices and 10 saved main-page reference boards. The approved specification takes precedence over incidental artwork.

System document picker, Android share sheet, Google account chooser, runtime permission dialogs and installer UI retain their platform-owned appearance. Legacy demo Workflow/Result screens are not new production destinations; their real equivalents are Home jobs / Job details / Player.

## State coverage and behavior contract

| Existing or requested flow | Design coverage |
|---|---|
| Login, registration, password reset | Approved auth board; full name added for registration. Auth form validation, busy and request feedback use shared state treatment 21. |
| Import picker and review | Native picker, board 01 review. Supported-file validation and errors remain real; no automatic cloud submission. |
| YouTube entry, permission confirmation, source transfer | Boards 02, 03, 24. Continue in 02 opens 03; download starts only after confirmation. Finished audio enters 01 separately before upload. |
| Home jobs, cancelled/failed/queued/worker-offline | Approved Home A; active details 04, result 05, shared states 21. Retry/cancel only when supported by actual task. Local source transfers join Home jobs. |
| Library and track details | Approved Library B and Details C. Processed results only; search/filter/star and mini-player. Missing job metadata is unavailable, not fabricated. Empty/search-no-results/offline use 21. |
| Playback and queue | Approved Player A; queue 06 A; board 07 C compact audio adaptation only. Complete acquired files persist for offline playback. No audio download just for preview. |
| Settings, accents, language, About | Approved Settings C and Color A; About 18. Profile first, accent entry added below; language inline; no theme-mode setting. |
| Profile, linked methods, devices | Approved C, B, C respectively. Read-only devices, Load more and Refresh. No per-device revoke feature inferred from icons. |
| Verification and linking | 08 unverified account; 10 reauthentication; 11 add password; 12 disconnect. Native Google UI. Already-linked Apple managed on iOS per source, not offered as new Android method. |
| Account recovery | 09 request and 23 pending. Rejected shows actual review reason; expired hides submission; approved refreshes account access. No review completion guarantee. |
| Account deletion and global sign-out | 13 review, 14 final, 15 global sign-out. Preserve two stages, actual auth requirements and three-month recovery policy. Current-device sign-out remains the existing direct action, no added confirmation mandated. |
| Rename/delete audio | 16 and 17. Existing media deletion scope illustrated; separate job-only deletion is not silently introduced. |
| Updates | 19 required, 20 optional, 22 download progress. Restoring/verifying/installer-waiting use indeterminate loading from 21; failure uses concrete actual reason and permitted retry. Cancelling download never bypasses mandatory update gate. |
| Notifications and platform operations | Existing optional completion-notification entry can use shared inline treatment; Android owns permission dialog. File export/share/install/Google account surfaces stay native. |

## Review caveats: artwork is not an implementation specification

These images were generated with the built-in imagegen tool and visually reviewed for layout. The text and behavior above take precedence over incidental generated details:

- Some dimmed backdrops invented menu items, slogans, passkeys, notifications settings, or audio split options. None are approved features. Retain only the actual selected page behind dialogs, or a neutral dim backdrop.
- Some active-job images added per-stage durations, vague time estimates, or determinate-looking progress. Use only actual available measurements; otherwise an indeterminate indicator. Do not copy invented timing or ETA.
- Decorative waves and illustrative artwork are not decoded audio data. Avoid reusing raster phone screenshots as production UI; implement responsive Compose controls and a reusable Canvas wave.
- Queue repeat must support off/all/one despite some draft images showing a binary switch. Keep one authoritative queue/player state; user-visible preference must not contradict active repeat-one behavior.
- The former video options are superseded by the audio-only requirement. Retain agreed audio controls and actual queue data; do not implement video surfaces or sample tracks.
- Some required-update progress art has a back arrow. Required gates must remain non-bypassable; platform exits must not expose blocked content. Update now/Check again visibility follows real policy and error state, not a permanent arbitrary button set.
- Destructive actions use semantic error color with readable contrast, even if a generated button looks orange. User-selected accent does not redefine destructive/error semantics.
- Version rows display real installed version/build without a navigation chevron. Samples never become application constants.
- Profile verification status is server-derived. Only real available account recovery status/deadline appears; corrected pending board contains no promised decision date.
- Title wording and controls must be localized, RTL-aware and responsive. Generated English screenshots do not validate layout with a keyboard, large text, Arabic, landscape or tablets.

## Validation performed

These images are design references, not screenshots of the implementation. Build and JVM validation are recorded separately in the implementation checkpoint. Android device, rendering and performance acceptance remain outstanding.
