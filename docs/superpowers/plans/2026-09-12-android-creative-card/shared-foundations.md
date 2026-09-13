# Shared foundation tasks — implement before screen redesign

Parent: [implementation plan](../2026-09-12-android-creative-card-redesign.md). Requirements: [approved spec](../../../design/creative-card/ANDROID-REDESIGN-SPEC.md).

`K` means `android/app/src/main/java/com/hatem/musicmute`; `T` means `android/app/src/test/java/com/hatem/musicmute`. New paths below are proposed implementation locations. Reuse an equivalent existing component if one is discovered during implementation; record the final location in the task rather than creating duplicates.

## Focused validation workflow

For meaningful new behavior, add the relevant test first, run it to observe the expected failure, implement the smallest shared change, then rerun that suite. Existing-behavior characterization tests should pass before refactoring. UI style-only changes use previews/build/lint instead of tests that mirror layout code.

Run from `/Users/hatemragap/work_spaces/music_remover/android`, with `ANDROID_HOME=/Users/hatemragap/Library/Android/sdk`. Example after F06 tests exist:

```sh
./gradlew :app:testDirectDebugUnitTest \
  --tests 'com.hatem.musicmute.processing.JobArtifactRepositoryTest' \
  --tests 'com.hatem.musicmute.library.OfflineLibraryTest'
```

Use the same `--tests` form for each task's classes: F02 `PreferencesRepositoryTest`/`AccentPaletteTest`, F03 `CreativeMotionTest`, F05 `ProcessingStoreTest`/`LibraryRepositoryTest`/`LibraryQueryTest`, F07 `PlaybackQueueTest`, F08 `AuthContractTest`/`AccountDeletionTest`/`RegistrationProfileTest`, with packages from their declared test paths. F04 uses shared Compose previews plus `:app:assembleDirectDebug :app:lintDirectDebug`. F09 runs both complete direct/play suites and builds from the parent plan. Never report a proposed test as already executed.

## F01 — inspect baseline and freeze domain boundaries

**Existing files:** `K/VocalApplication.kt`, `K/MainActivity.kt`, `K/ui/VocalApp.kt`, `K/state/ProcessingViewModel.kt`, `K/state/DownloadsViewModel.kt`, `K/processing/AudioTaskPresentation.kt`, `K/processing/JobHistoryController.kt`, `K/processing/ProcessingStore.kt`, `K/processing/JobArtifactRepository.kt`, `K/playback/AudioPlaybackController.kt`, `K/playback/AudioPlaybackService.kt`, `K/ui/auth/AuthGate.kt`.

**Deliverable:** a small source map and stable boundaries, not a replacement application architecture.

- [ ] Re-read current instructions, README, Gradle manifests and the listed producers/consumers; inspect git status and preserve unrelated work. Record baseline test/lint failures before attributing failures to redesign.
- [ ] Identify production routes versus legacy `WorkflowScreen`, `ResultScreen`, demo Library and `legacy_library` paths. Map real destinations to Home jobs, Library, Player and Settings; do not revive demo state.
- [ ] Preserve `AudioTaskPresentation` for job status/timing, `ProcessingSession(uid, epoch)` for ownership, `JobArtifactRepository.ensureOutput(jobId): File` for acquisition and `AudioPlaybackService` for playback.
- [ ] Define new presentation models in **new** `K/library/LibraryModels.kt` and playback queue models in **new** `K/playback/PlaybackQueue.kt`. They contain stable job IDs, no signed URLs, credentials or duplicate cloud entities.
- [ ] Record existing deletion, owner-switch, update and offline-auth guards as invariants in tests before extending behavior. Do not add a new backend field/API to make UI state easier.

The minimum Library boundary below is the planned shared contract. All referenced custom types are defined here; implementations belong to F05/F06. Kotlin `File`, `Flow`, `StateFlow` and coroutine types use their existing standard imports.

```kotlin
data class LibraryKey(val ownerUid: String, val jobId: String)
enum class OfflineStatus { REMOTE_ONLY, DOWNLOADING, AVAILABLE, FAILED }
enum class LibraryFilter { ALL, STARRED, DOWNLOADED, NOT_DOWNLOADED, REMOVED }
enum class LibrarySort { NEWEST, TITLE }
enum class LibraryProblem { OFFLINE, MISSING_FILE, STORAGE, TRANSFER, INVALID_AUDIO }
data class LibraryEntry(
    val key: LibraryKey,
    val title: String,
    val createdAtEpochMs: Long,
    val durationMs: Long?,
    val starred: Boolean,
    val hidden: Boolean,
    val offlineStatus: OfflineStatus,
    val downloadedBytes: Long = 0,
    val totalBytes: Long? = null,
    val problem: LibraryProblem? = null,
)
interface LibraryRepository {
    val entries: StateFlow<List<LibraryEntry>>
    suspend fun setStarred(key: LibraryKey, starred: Boolean)
    suspend fun setHidden(key: LibraryKey, hidden: Boolean)
    suspend fun ensureLocal(key: LibraryKey): java.io.File
    suspend fun localFile(key: LibraryKey): java.io.File?
}
```

The application binds the repository to its current `ProcessingSession`; all writes and returned files recheck the owner/epoch. `localFile` never uses the network. `entries` emits only the current owner's entries and clears on sign-out. UI filtering is a pure projection of the catalog, not an API query on every keystroke. Stored records use compatible serialization defaults and do not persist transient download progress.

**Acceptance:** concrete file owners and route consumers are known; no screen agent needs to invent a data source. Focused existing tests establish a baseline.

## F02 — dark design tokens and persistent accent

**Modify:** `K/ui/Theme.kt`, `K/data/PreferencesRepository.kt`, `K/MainActivity.kt`, `T/data/PreferencesRepositoryTest.kt`.

**New:** `K/ui/design/CreativeTokens.kt`, `K/ui/design/AccentPalette.kt`, `T/ui/design/AccentPaletteTest.kt`.

- [ ] Define shared roles for background, raised card, sheet, border, primary/secondary/muted text, primary action, selected state, success/warning/error and wave layers. Reuse existing typography/shapes where consistent; define spacing, card radius and content-width tokens once.
- [ ] Generate dark `ColorScheme` from an opaque accent; default `0xFFFF814A`. Pick readable foregrounds using contrast calculation. If the raw accent cannot be legible as small text on dark surfaces, derive a tonal text role while preserving the selected swatch and primary action color.
- [ ] Add `accentArgb` to `AppPreferences` and `setAccent(argb: Int)` to its repository/implementations. Validate/normalize custom input to opaque sRGB. Keep locale selection unchanged.
- [ ] Migrate stored SYSTEM/LIGHT/DARK preferences to the single dark runtime behavior without crashing on old/unknown values. Remove theme-choice UI; avoid unnecessary destructive DataStore resets. Update `VocalTheme` consumers and system bars consistently.
- [ ] Expose tokens via the existing Compose theme, not passing unrelated colors through every screen. Keep semantic error/destructive colors outside user accent customization.
- [ ] Test preference restart/default migration, invalid colors and foreground contrast across light/dark/extreme accents. Check small text contrast at least 4.5:1 and large text/essential controls at least 3:1 for supported token combinations.

**Acceptance:** all shared previews are dark, accent persists after repository recreation and no main screen uses a hard-coded orange/green primary color.

## F03 — one reusable A motion system

**New:** `K/ui/design/CreativeMotion.kt`, `K/ui/design/CreativeWave.kt`, `T/ui/design/CreativeMotionTest.kt`.

**Consumers:** F04 controls/sheets and all future screens. Use Compose/Canvas already in the project; no animation library is required.

- [ ] Create shared duration/easing constants for wave 12 s, sheet open 340 ms/close 300 ms, navigation 230 ms, star 300 ms and primary pressed scale 0.975. Use a restrained 16 dp route translation initially; it is not the preview's pixel coordinate.
- [ ] Implement `CreativeWave(modifier: Modifier, active: Boolean, intensity: Float)` using theme accent layers, normalized Canvas geometry and remembered paths/paint data. Clamp intensity to a safe range. The caller supplies visibility/playback context; the implementation also observes lifecycle and system motion settings.
- [ ] Define a shared motion-enabled state derived from platform animation settings; do not add an unapproved Settings feature. Disabled motion renders a static wave and eliminates decorative transitions.
- [ ] Drive wave phase without recomposing the whole screen/list each frame. Reuse one header/player wave per visible composition, not an independently animated waveform in every Library card. Small row motifs may remain static.
- [ ] Pause offscreen and when backgrounded. Audio playback can continue through the media service while decorative animation stops. Resume without resetting navigation, playback or user input.
- [ ] Apply native ripple to standard rows/toolbars; add restrained scale only to intended primary buttons. Handle press cancel, drag-out, disabled and busy states; animation never dispatches an action twice or delays the request.
- [ ] Unit-test pure phase/reduced-motion policy and lifecycle eligibility where practical; use previews for static endpoints. Do not add tests that merely repeat duration constants.

**Acceptance:** selected A motion is centrally controlled, follows accent, stops when inactive and contains no disk/network work in the draw path. Smoothness remains a runtime measurement, not a claim from a preview.

## F04 — shared components, sheets and state placement

**New:** `K/ui/design/CreativeScaffold.kt`, `CreativeCard.kt`, `CreativeActions.kt`, `CreativeFields.kt`, `CreativeSheet.kt`, `CreativeFeedback.kt` in the same `ui/design` directory.

**Modify as needed:** existing composables in `K/ui/VocalApp.kt` and `K/ui/auth/AuthScreen.kt` only to extract reusable styles; preserve behavior.

- [ ] Create responsive scaffold/header/card primitives with safe system insets, keyboard padding, bounded wide-screen content, reusable icon/text spacing and title hierarchy. Keep existing wide navigation-rail behavior where applicable.
- [ ] Create text/password fields with labels, inline validation, visibility toggle, keyboard actions, autofill hints and stable semantics. Preserve entered fields on configuration change without persisting passwords to disk/logs.
- [ ] Create primary/secondary/destructive actions with busy/disabled states, consistent minimum 48 dp targets and semantics. Colors/styles come only from F02.
- [ ] Create a sheet host using platform Compose modal behavior with shared A motion where configurable; preserve swipe/back dismissal, focus restoration, keyboard scrolling and accessibility announcements. Do not replace native gesture handling just to match a millisecond value.
- [ ] Use dialogs for selected final irreversible confirmations, not sheets everywhere. Allow dismissal before a request when safe; once a destructive request is accepted/in flight, preserve the existing busy/receipt handling rather than losing its outcome.
- [ ] Create shared state placements: centered for an otherwise empty page, inline for failures/loading alongside existing content, compact for action progress. Keep selected page layout and cached data visible on refresh failure.
- [ ] Create preview fixtures for normal/busy/empty/error, Arabic RTL, large font and narrow/wide layouts. Include content descriptions, selected states and distinct message/action semantics.

**Acceptance:** one implementation of each field, card, sheet, action and feedback style is ready for screen agents. No backend or fake business logic is embedded in widgets.

## F05 — persistent processed-results catalog

**Modify:** `K/processing/ProcessingStore.kt`, `K/processing/JobHistoryController.kt`, `K/VocalApplication.kt`, `T/processing/ProcessingStoreTest.kt`.

**New:** `K/library/DefaultLibraryRepository.kt` implementing the F01 `LibraryRepository` interface, `K/library/LibraryQuery.kt`, `K/state/LibraryViewModel.kt`, `T/library/LibraryRepositoryTest.kt`, `T/library/LibraryQueryTest.kt` plus models defined in F01.

- [ ] Extend the existing owner-scoped `ProcessingDocument` with compatible defaults for Library metadata/local flags. Use existing DataStore/serialization instead of introducing Room. Upgrade schema deliberately and test reading the current version-2 document.
- [ ] Materialize one entry per ready processed job from real job snapshots. Never add originals, incomplete jobs or source-only downloads. No output fetching during reconciliation.
- [ ] Persist metadata across history pagination and refresh. Inspect `saveSnapshots` replacement behavior: a first-page refresh must not erase older Library tracks, stars or hidden flags. Only explicit authoritative deletion removes entries; absence from one page is not deletion.
- [ ] Persist stars and local hide/restore per owner. Normal filters exclude hidden entries; REMOVED shows them and offers Restore. Hiding does not delete local files or cloud data and does not alter a queue already playing; confirmed cloud deletion removes the queued item through F07.
- [ ] Implement case-insensitive title search, filters All/Starred/Downloaded/Not downloaded/Removed and Newest/Title sorting as pure functions with deterministic ties. Handle Unicode/Arabic and whitespace; keep query/filter while visiting player/details.
- [ ] Subscribe to current-session job updates and acquisition status; expose immutable entries. Observe metadata first so Library renders saved tracks without waiting on cloud refresh.
- [ ] Add a local reconciliation pass that checks saved-file presence off the main thread. Do not decode every file on every composition; full validation occurs on acquisition/play and persisted availability is reconciled efficiently.
- [ ] Test duplicate completions, pagination merge, restart, hidden-entry sync, owner switching, Unicode query, filter intersections and retained data on offline refresh errors.

**Acceptance:** Library opens from persisted metadata with zero audio downloads, only processed results appear and local user choices survive restart.

## F06 — complete offline acquisition, persistence and restore

**Modify:** `K/processing/JobArtifactRepository.kt`, `K/processing/ArtifactDownloadTransport.kt` only if completeness checks need strengthening, `K/state/ProcessingViewModel.kt`, `K/VocalApplication.kt`, `K/auth/AuthSessionCoordinator.kt` only if a proven restore gap exists, `T/processing/JobArtifactRepositoryTest.kt`, `T/auth/AuthContractTest.kt`.

**New tests:** `T/library/OfflineLibraryTest.kt`. Implement F01 `LibraryRepository.ensureLocal/localFile` through the existing artifact repository.

- [ ] Keep the existing `noBackupFilesDir/processing/artifacts` root, hashed owner/job paths, session revision fencing, deduplicated deferred requests and atomic `.partial` commit. Do not move outputs into `cacheDir` or a second player cache.
- [ ] Add a local-only artifact lookup API through the repository, with the same owner checks and validation as cached `ensureOutput`. Never expose arbitrary filesystem paths to screen callers.
- [ ] Verify full-transfer completion: transport EOF/success, declared length equality when provided and existing playable-MP3 validation before commit. A merely decodable prefix must not earn Available offline when the expected byte count proves truncation. Do not fabricate a checksum if the server supplies none.
- [ ] Set downloading progress from real bytes/total; unknown total is indeterminate. Available offline is emitted only after atomic file success. On cancellation, storage failure, invalid audio or process interruption, preserve older valid files and clear only partials owned by that attempt.
- [ ] Route Play, Download/Keep offline and Share through the same `ensureLocal`. First Play waits for the complete file and then starts; no streaming-only route that loses the rest of the track offline. Existing Save a copy remains a distinct document export.
- [ ] Reuse valid cached files before job-detail/download-grant calls, even if a previous signed URL expired. Dedupe simultaneous actions. Fetch failure does not erase a valid catalog entry.
- [ ] Restore the same cached authenticated account using the existing `AuthProblem.OFFLINE` bootstrap fallback and persisted Library index. Bound startup network waits through existing timeout behavior; ensure local navigation/playback is not blocked indefinitely by a refresh. Do not transform authentication failures/revocation into offline success.
- [ ] Clear active playback/UI immediately on sign-out/account switch and preserve current purge rules. Add new Library metadata and queue state to `purgeDeletedAccount`; no owner's async download completion can enter a later session.
- [ ] Cover download → recreate repository → offline full-file playback resolution with fake API/downloader that throw on every network call. Assert byte equality and no API calls; test truncated transfer, zero-byte/corrupt file, lost file, disk-write failure, concurrent callers, cancellation, expired grant, owner switch and deletion during download.

Concrete test shape for implementers: construct the existing artifact test harness with a known MP3 payload; acquire once; construct a second repository over the same temp root and same owner with a network-forbidden fake; call `ensureOutput(jobId)`; assert exact saved bytes and zero calls to fake `detail/download/downloader`. This tests persistence and request ordering rather than mocking the cache hit itself. Adapt the existing harness, do not create an empty placeholder assertion.

**Acceptance:** JVM evidence proves durable complete-file reuse and ownership rules. Actual app kill/reboot/airplane-mode playback remains in runtime acceptance after an Android target is authorized.

## F07 — one authoritative Media3 queue and player

**Modify:** `K/playback/AudioPlaybackController.kt`, `K/playback/AudioPlaybackService.kt`, `K/state/ProcessingViewModel.kt`, `K/VocalApplication.kt`.

**New:** `K/playback/PlaybackQueue.kt` from F01, `T/playback/PlaybackQueueTest.kt`. Extend current `PlaybackState`; do not introduce a second competing player state for Library.

Minimum shared command surface on the controller:

```kotlin
enum class RepeatMode { OFF, ALL, ONE }
data class QueueTrack(val key: LibraryKey, val title: String)
interface QueueCommands {
    fun playQueue(tracks: List<QueueTrack>, startKey: LibraryKey)
    fun next()
    fun previous()
    fun setShuffle(enabled: Boolean)
    fun setRepeat(mode: RepeatMode)
    fun setAutoNext(enabled: Boolean)
}
```

`AudioPlaybackController` implements `QueueCommands` and remains the producer of `PlaybackState`. Add `queue: List<QueueTrack> = emptyList()`, `currentIndex: Int = -1`, `repeatMode: RepeatMode = RepeatMode.OFF`, `shuffle: Boolean = false` and `autoNext: Boolean = true` to that existing state with defaults. Existing `seek(positionMs: Long)` and session cleanup remain. Commands launch acquisition/session work in the existing scoped architecture and report progress/errors through shared state, not unhandled UI coroutines.

- [ ] Inspect controller/service ownership and make queue decisions service-backed so auto-next and media buttons work after the screen/controller is detached. Never depend on a visible Composable to advance a track.
- [ ] Use stable owner/job identities in MediaItems. Feed validated local file URIs through F06; do not persist signed remote URLs. Bridge the existing processing playback record IDs during migration so mini-player/result agree on current track.
- [ ] Define queue creation from the currently visible Library order when a user taps a track. Freeze that queue snapshot; typing another search does not unexpectedly replace playback. Queue selection changes the same session.
- [ ] Implement end-of-track precedence: repeat ONE repeats current; otherwise autoNext false stops at end; autoNext true advances in queue/shuffle order; repeat ALL wraps, OFF stops at final item. Manual next/previous operates independently of autoNext; previous restarts current after 3 seconds, otherwise selects previous.
- [ ] Online auto-next may acquire the next requested output through F06; avoid bulk predownload of the entire Library. Offline advancement skips missing files once and stops after one bounded queue pass. Repeat-one on a missing file reports unavailable and stops.
- [ ] Shuffle uses a stable order until queue/settings change, preserving current item and avoiding duplicate/lost entries. Persist owner-scoped queue, index, position and preferences; restore paused, never autoplay merely because the app reopened.
- [ ] Keep playback notification/media session, lock-screen controls, audio focus, becoming-noisy/headphone handling and background lifecycle coherent with existing service. Determine these from actual Media3 configuration and add missing handling only as needed.
- [ ] Miniplayer, Player, queue sheet and result all observe the same controller state. Detaching a page must not destroy a shared application/session controller; adjust existing ViewModel `onCleared` release ownership carefully.
- [ ] Test the end-of-track matrix, shuffle membership, missing-file bounded traversal, repeat-one precedence, seek clamping, owner change and restored-paused state. Verify actual media buttons/background behavior later on the authorized Android target.

**Acceptance:** one service/session is authoritative for every playback surface and offline progression cannot spin or leak another owner's queue.

## F08 — auth/full-name and shared business action adapters

**Modify:** `K/auth/AuthModels.kt`, `K/auth/FirebaseAuthGateway.kt`, `K/auth/AuthSessionCoordinator.kt`, `K/state/ProcessingViewModel.kt`, `K/ui/auth/AuthGate.kt` only where needed for stable contracts.

**Tests:** extend `T/auth/AuthContractTest.kt`, `T/auth/AccountDeletionTest.kt`; add **new** `T/auth/RegistrationProfileTest.kt` for isolated validation/failure policy.

- [ ] Extend registration only with a trimmed required full name. Retain sign-in compatibility by adding a nullable/defaulted argument or a separate registration method. Login/reset do not start requiring a name.
- [ ] Use Firebase user `updateProfile` for the display name, protected by existing identity mutation/session checks; add a defaulted nullable display-name field to the internal identity snapshot. Do not invent an Android-only REST profile field. Profile shows server-supported identity fields plus Firebase display name with a sensible fallback.
- [ ] Handle partial registration success: if account creation succeeds but name update fails, do not try creating the account again. Keep the authenticated identity and present retry for the pending profile update; preserve existing bootstrap and duplicate-account protections. Persist only necessary owner-scoped pending name data if recovery must survive restart; never passwords.
- [ ] Keep auth validation/provider/link/unlink/verification/recovery/deletion methods centralized in `AuthSessionCoordinator`; screens bind state and dispatch actions. Preserve Google native credential flow, Apple current capabilities and at-least-one-method guard.
- [ ] Keep rename/delete/retry/cancel/export/share centralized in current processing coordinator/ViewModel, adapting Library selection to job IDs explicitly. Do not make screen agents call JobsApi directly.
- [ ] Freeze names and state mappings for offline local actions versus network-required operations. Invalid/revoked auth remains a security state, not a generic retryable network error.
- [ ] Test blank/Unicode names, existing login calls, profile-update failure recovery, stale session result rejection and existing deletion/link safeguards.

**Acceptance:** screen workers can implement every selected account/form surface without modifying domain contracts or backend APIs.

## F09 — route integration and shared foundation acceptance gate

**Modify:** `K/ui/VocalApp.kt`, `K/ui/auth/AuthGate.kt`, `K/MainActivity.kt`, `K/VocalApplication.kt`.

**New:** `K/ui/navigation/CreativeDestination.kt`. Use a small typed destination/selected-ID model compatible with existing navigation; no package addition is required.

- [ ] Wire Home/Library/Settings as stable main destinations; Player/details/account child screens keep their proper return destination. Preserve tab query/scroll state and existing external-intent selection behavior.
- [ ] Create stable route signatures carrying only operation/job IDs, never files/tokens. Distinguish active job detail, result, track detail and source download detail while sharing real task state.
- [ ] Decide and document mini-player placement once: above bottom navigation on main tabs when a track is selected; absent from auth/recovery/blocking update; no duplicated mini-player in full Player.
- [ ] Ensure mandatory update and account gates wrap new routes. Back/sheet dismissal cannot bypass them. Remove obsolete demo navigation only after real consumers are redirected.
- [ ] Integrate strings through existing English/Arabic resources. Freeze component APIs, models, callbacks and semantics tags for future workers in a short in-repo contract note alongside these tasks.
- [ ] Run focused foundation suites, then direct/play JVM tests, lint and debug assembly using the parent plan command. Record baseline versus new failures honestly.
- [ ] Review the foundation checklist: persisted accent; static reduced-motion path; reusable sheet/field/card; processed-only catalog; complete offline acquisition; owner fencing; background-owned queue; working auth/action adapters; no routes bypassing gates.
- [ ] Only mark this gate passed when shared implementation compiles and focused behavior tests pass. Android runtime proof may remain separately pending due to target authorization; do not call it verified.
- [ ] Once the gate passes, launch the parallel screen lanes in the parent plan with explicit ownership. If a shared issue appears later, coordinator fixes it before dependent screen work continues.

**Acceptance:** all future screen agents consume one tested foundation and do not independently implement theme, animation, cache, auth or playback logic.
