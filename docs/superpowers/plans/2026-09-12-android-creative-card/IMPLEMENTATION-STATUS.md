# Implementation status

Implementation authorized on 2026-09-13; branch `codex/android-creative-card`, current repository. No commits, pushes, deployment or device use.

## Shared foundation gate

Core F01–F08 changes are implemented: single dark theme and persisted accent, shared A motion/components, persistent processed-only catalog/search/filter/stars, full-file offline lookup/acquisition, service-owned queue/persistence and registration full-name retry. F09 build/test gate passed before screen lanes start. Final route integration and full-screen acceptance continue below; runtime verification is not claimed.

Validation on the integrated foundation: both `testDirectDebugUnitTest` and `testPlayDebugUnitTest`, both `lintDirectDebug`/`lintPlayDebug`, both `assembleDirectDebug`/`assemblePlayDebug` passed. SDK path was supplied with `ANDROID_HOME=/Users/hatemragap/Library/Android/sdk`. Initial missing SDK environment was corrected without changing local properties.

Independent review found and verified fixes for: equal-timestamp rename overwrite, lost rapid star toggles, queue checkpoint overwrite during cold auth restoration, initial screen attachment clearing playback, and legacy result playback escaping exact-track deletion. Tests cover persistence/queue policy/owner fencing; actual Android service lifecycle remains unverified.

## Active screen lanes

- Intake/jobs worker: S04–S09, `ui/home`, `ui/importing`, `ui/jobs`, existing job/download detail/timeline adapters.
- Library/player worker: S10–S14, `ui/library`, `ui/player`; preserve shared media/domain code.
- Auth/account worker: S01–S03 and S17–S22, `ui/auth` except coordinator-owned `AuthGate.kt`.
- Coordinator: S15/S16/S23–S25, navigation, application integration and final acceptance.

Resource ownership refinement for parallel compilation: each lane owns separate `values/creative_jobs.xml`, `creative_library.xml` or `creative_account.xml` and matching `values-ar` file; coordinator owns existing shared resources and `creative_settings.xml`. Prefix keys by lane. This refines the plan's central resource editing rule without changing product scope.

## Shared APIs for screen workers

- Use `ui/design/CreativeComponents.kt`: `CreativePage`, `CreativeHeader`, `CreativeCard`, `CreativePrimaryButton`, `CreativeTextField`, `CreativeSheet`, `CreativeFeedback`, `CreativeStarButton` and `CreativeWave`.
- Use `VocalTheme`/MaterialTheme colors. Motion already observes lifecycle/system setting once per theme host. No per-screen animation engine or player.
- `LibraryUiState`/`LibraryViewModel`: query/filter/sort, toggleStar, download, setHidden, refreshLocal, clearProblem.
- `PlaybackState`/`AudioPlaybackController`: queue/currentIndex, togglePlayback, playQueue, next/previous, seek, setRepeat/setShuffle/setAutoNext, removeTrack. The application owns the controller; screens never release it.
- Existing `ProcessingViewModel`/`JobHistoryState`/`AudioTaskPresentation` remain job/action sources.
- Existing auth coordinator signatures remain; registration now passes `fullName`, `pendingProfileName` supports `retryProfileName`. Preserve these additions.
- Keep existing public composable signatures when editing existing files; new screen composables should accept state and callbacks, then report exact signatures for coordinator wiring.
- Reuse shared rename/delete sheets from Library lane across job details. Preferred signatures: `RenameAudioSheet(title, busy, onDismiss, onRename)` and `DeleteAudioSheet(title, busy, onDismiss, onDelete)`.

## Integrated application checkpoint

Home now opens the approved compact jobs view with import, secondary YouTube, in-list Load more, feedback and notification opt-in. Import review and YouTube consent use the shared sheets. Settings opens the selected Profile-first layout, persisted accent picker and workflow About page. Main tabs are Home, Library and Settings, with shared directional motion and no tab bar on detail/player routes.

Library, full Player, queue and track details are connected to the application-owned catalog and Media3 controller. Home and Library expose the compact player. Track details read persisted job metadata while cloud refresh is unavailable. Download, Save copy and Share acquire the complete local result without depending on an online detail response. Queue selection preserves the existing playlist/shuffle state, and progress ticks reuse cached queue lists rather than traversing a large playlist every 500 ms.

The restart integration test now reopens both catalog and artifact repositories after closing the first metadata store. It verifies title, star, offline availability, stored job metadata and full audio bytes with network detail/grant/transfer forbidden. The initial test timeout was a fixture lifecycle error (two simultaneously active DataStores for one file), corrected by closing the first simulated process before reopening it.

After the latest queue/test/auth changes, the full gate passed: 223 direct JVM tests and 203 Play JVM tests, zero failures/errors/skips, both lint tasks and both APK assemblies. Shared resource sets have matching English/Arabic keys (23 account, 18 jobs, 67 library, 22 settings), and the tracked source diff remains Android-only. Diff whitespace checks pass. These are build/JVM results, not Android runtime or visual acceptance.

## Screen-audit follow-up

Removed obsolete prototype Home/Workflow/Result/Library/Settings composables from the app host and replaced their previews with the actual Creative screens, including Arabic and narrow/large-text fixtures. Home A job cards now use shared compact spacing and move actions below content on narrow/large-text layouts. Library B no longer squeezes four actions beside the title. These changes were compared to the approved reference boards; previews have compiled but have not been rendered on Android.

The Player's Up next now follows actual shuffle order and repeat/auto-next policy, covered by an added queue test. Catalog title changes update existing Media3 metadata for the queue/system controls. A recovered READY player clears stale failure feedback, and Retry prepares a failed player. The Library and navigation host no longer collect position ticks; only the visible full/mini-player does. Shared transitions now also cover authentication forms and account navigation, with directional RTL and disabled-motion handling. Connection/bootstrap content uses shared cards. All surface-container roles are explicitly dark neutral colors, and selected tab colors follow the chosen accent.

The full six-task build/test/lint gate passed after these functional changes: 224 direct JVM tests and 204 Play JVM tests, zero failures/errors. Both APK builds and lint checks passed again after the final tab label/color and translation adjustment. Resource parity is now 23 account, 18 jobs, 68 library, 22 settings keys per locale. Diff whitespace checks pass.

## Remaining acceptance

The source/build audit is recorded in [ACCEPTANCE.md](../../../design/creative-card/ACCEPTANCE.md), including every main page and all 24 numbered choices. Additional fixes made during this audit: job-result Save/Share use the offline-capable output path; job/source/track routes carry explicit identities; mutations use initiating IDs; completed deletion cannot pop another page or clear another selected task; result sheets display errors; source pages show local-import stages truthfully and handle unavailable details; required/optional update UI respects system insets; recovery pending does not imply that review has started.

The latest six-task gate passed after these fixes: 224 direct tests and 204 Play tests, both APK assemblies and both lint tasks. Translation parity now includes 19 jobs keys (other groups remain 23 account, 68 library and 22 settings).

Do not mark the full redesign complete from compilation or JVM proof alone. Device audio decoding, offline restart, background playback, nested navigation, layout/accessibility and animation performance remain unverified until an Android target is authorized. No authorized Android target has been provided; the user's existing device rule only permits an iPhone simulator.
