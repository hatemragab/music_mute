# Complete Android screen task sheet

Parent: [implementation plan](../2026-09-12-android-creative-card-redesign.md). All tasks depend on **F09 shared foundation gate**. Use [approved spec](../../../design/creative-card/ANDROID-REDESIGN-SPEC.md) and [gallery](../../../design/creative-card/GALLERY.md) together; written requirements override generated details.

`K` = `android/app/src/main/java/com/hatem/musicmute`; `T` = `android/app/src/test/java/com/hatem/musicmute`. Proposed new screen files are labeled **new**. Navigation, shared resources and domain changes belong to the coordinator, even when another agent owns the screen.

## Common definition of done for every screen

- [ ] Use F02–F04 tokens/components/motion. No independent palette, wave engine, custom sheet animation or API client.
- [ ] Implement normal, loading, busy, validation, empty, offline and failure states that actually apply. Keep cached content on refresh errors; prevent duplicate submissions; never invent progress or success.
- [ ] Preserve entry state across appropriate navigation/rotation, use real localized copy and support Arabic RTL, keyboard, large fonts, TalkBack, safe insets and narrow/wide layouts.
- [ ] Remove profile shortcuts from headers; Settings owns the first Profile row. Follow shared mini-player placement, including no duplicate in full Player.
- [ ] Add representative Compose previews. Add focused tests for meaningful changed behavior, not static styling assertions; pure rules belong to shared tests.
- [ ] Run affected JVM checks and compile the relevant variant. Coordinator integrates translation keys and navigation before lane acceptance. Record device/UI checks as pending until an Android target is authorized.

## S01 — Login

**Reference:** approved Creative Card auth board. **Owner:** Agent C.

**Modify:** `K/ui/auth/AuthScreen.kt`; optionally extract **new** `K/ui/auth/LoginScreen.kt` while retaining one existing mode/state host.

- [ ] Use shared auth scaffold, restrained wave, title/subtitle, email/password card, primary Login action, reset link and Create account navigation. Preserve native Google sign-in and existing legal links.
- [ ] Use appropriate keyboard/autofill/IME actions, password visibility, validation and disabled/busy state. Keep email across failed attempts; do not persist password to disk or include it in navigation state/logs.
- [ ] Distinguish invalid input/credentials, network failure and backend bootstrap state using existing auth messages. Loading must not collapse the selected layout or display false success before bootstrap.
- [ ] Preserve saved form/navigation state on safe configuration changes and native Google cancellation. No profile icon or mini-player while signed out.

**Acceptance:** valid login reaches the proper auth/update gate; invalid input does not dispatch; repeated taps create one request; reset/register/back links work.

## S02 — Create account

**Reference:** approved Creative Card auth board with Full name. **Owner:** Agent C.

**Modify:** `K/ui/auth/AuthScreen.kt`; optional **new** `K/ui/auth/CreateAccountScreen.kt`.

- [ ] Present Full name, Email, Password and Confirm password in the shared form card, primary Create account action and return-to-login link. Make the full form scroll above the keyboard without hiding errors/CTA.
- [ ] Validate trimmed nonempty name, existing email/password policy and password confirmation before F08 registration. Support Unicode names; do not invent restrictive first/last-name assumptions.
- [ ] Display separate account-created/name-update-retry state if F08 reports partial success. Never resubmit account creation merely to retry saving a name.
- [ ] Use existing provider/legal requirements and messages. Show actual identity after success; no new backend profile payload or verification promise.

**Acceptance:** name appears in Profile after successful Firebase profile update; mismatch/blank name shows inline; partial registration recovery preserves the created identity. Extend the auth form validation tests where rules change.

## S03 — Forgot password

**Reference:** approved Creative Card auth board. **Owner:** Agent C.

**Modify:** `K/ui/auth/AuthScreen.kt`; optional **new** `K/ui/auth/ForgotPasswordScreen.kt`.

- [ ] Shared wave/form composition, email field, Send reset link action and Back to login.
- [ ] Preserve existing Firebase reset behavior and safe request feedback. Do not expose account existence through new copy or claim delivery beyond what the operation confirms.
- [ ] Show inline input/request errors, busy state and success presentation in the same card; allow correction/retry according to existing cooldown behavior.

**Acceptance:** one request per action, invalid email blocked, successful request feedback visible and back navigation retains sensible form context.

## S04 — Home: jobs instead of recent audio

**Reference:** approved Home A Compact. **Owner:** Agent A.

**New:** `K/ui/home/HomeScreen.kt`, `K/ui/home/JobCard.kt`. **Coordinator modifies:** `K/ui/VocalApp.kt` route/call site.

- [ ] Compact Creative Card header/wave, primary Import audio and visible secondary YouTube entry; no profile icon and no recent-audio block.
- [ ] Render current processing operations and historical jobs through existing `AudioTaskPresentation`/history state. Avoid duplicate cards when a local operation receives its server job ID. Keep source download progress inspectable alongside jobs.
- [ ] Show truthful state, title, relevant timestamp/progress and compact valid actions. Processing elapsed and media duration must remain distinct; unknown percentage/ETA stays indeterminate.
- [ ] Put Load more within the jobs list footer. Retain existing cards and scroll on pagination loading/failure; retry footer failures inline. Do not use a page-wide blocking spinner for load more.
- [ ] Active card opens S07, ready card S08 and source download S09. Preserve cancellation/retry permissions and offline cached list access. Shared mini-player sits above bottom navigation when active.

**Acceptance:** no recent media section; known job updates reconcile without duplicates; footer loads the next page without erasing earlier jobs. Add focused list mapping/pagination tests if adapters change.

## S05 — Import review bottom sheet

**Reference:** board 01 C. **Owner:** Agent A.

**New:** `K/ui/importing/ImportReviewSheet.kt`. **Coordinator adapts:** current import-review host in `K/ui/VocalApp.kt`.

- [ ] Present selected audio title, real duration/size when known, validation state and the approved compact wave/card arrangement.
- [ ] Preserve the full rights confirmation and private cloud upload disclosure from current resources. Primary Remove music dispatches `confirmCloudProcessing` only when validation and consent permit it.
- [ ] Preparing, unsupported/unreadable input, exceeded actual limits, canceled selection and storage errors use shared feedback. Never copy illustrative file limits over current validation.
- [ ] Dismiss/cancel uses the existing discard-review behavior. Dismissing a review cannot start upload. Process recreation must not silently infer consent.
- [ ] Use F04 sheet motion, keyboard/accessibility/large-text handling; Android document picker remains native.

**Acceptance:** selecting/pasting a source alone never authorizes cloud upload; review details and disclosure fit; one confirmed operation is submitted.

## S06 — YouTube link and confirmation sheets

**Reference:** board 02 C, board 03 B. **Owner:** Agent A.

**New:** `K/ui/importing/YoutubeLinkSheet.kt`, `K/ui/importing/YoutubeConfirmationSheet.kt`.

- [ ] Link sheet includes URL field, explicit Paste, clear validation and Continue. Preserve current URL handling and real error messages. Do not auto-submit from recomposition or clipboard observation.
- [ ] Continue opens the confirmation sheet; preserve actual rights/disclosure checkbox and explicit start-download action. Link entry and preview do not start cloud processing.
- [ ] Keep cancel/back transitions coherent: backing out returns to editable URL; cancellation does not create duplicate intents. Use existing processing/source coordinator state for request identity.
- [ ] Confirmed download appears as an individual Home task; progress opens S09. Finished source enters the import review/consent flow before upload as required by the current pipeline.
- [ ] Show offline/invalid/unavailable source errors with retry only when meaningful. Keep YouTube secondary and truthfully described.

**Acceptance:** URL → confirmation → source transfer → review is traceable, with no duplicate task from rapid taps or rotation and no implicit upload.

## S07 — Active job details timeline

**Reference:** board 04 A. **Owner:** Agent A.

**Modify:** `K/ui/ProcessingDetailScreen.kt`, `K/ui/AudioStepTimeline.kt`; extract **new** `K/ui/jobs/ActiveJobScreen.kt` if needed.

- [ ] Shared title/wave, media summary and timeline using real task stages. Keep job/reference copy, source metadata, duration and total/processing elapsed with approximate flags where supplied.
- [ ] Reflect queued, preparing/uploading/processing, processing-unavailable, cancel-requested, cancelled and failed states. Do not infer execution capacity, ETA or per-stage timings from art.
- [ ] Wire valid cancel/retry/refresh actions to current ViewModel; while cancellation is pending, keep truthful status until confirmed. Preserve selected task across refresh and navigation.
- [ ] Ready transition routes/presents S08 using the same selected ID. Offline view retains last-known metadata with a clear stale/offline treatment.

**Acceptance:** status/action mapping matches existing domain rules and unknown timing is not fabricated. Extend `AudioTaskPresentation` tests only if mapping changes.

## S08 — Completed result timeline

**Reference:** board 05 C. **Owner:** Agent A.

**New:** `K/ui/jobs/CompletedResultScreen.kt`; reuse `ProcessingDetailScreen` adapter/state.

- [ ] Present completed title, compact wave/result card and real completion timeline. Show actual duration and processing elapsed separately.
- [ ] Completed metadata is automatically reflected in Library through F05 even if this page is never visited. Opening it does not fetch audio.
- [ ] Play opens S11 through F07/F06; Download means durable Keep offline, Save a copy uses existing export, Share uses existing native sharing after file acquisition. Show shared transfer state and Available offline badge.
- [ ] Job info and rename/delete lead to the shared detail/action flows. Refresh failures do not erase the saved result. A ready job whose output is not yet downloadable must show its actual availability state.

**Acceptance:** action-triggered full-file retrieval is deduplicated and a completed entry appears in Library without first opening the result screen.

## S09 — Source download detail

**Reference:** board 24 B. **Owner:** Agent A.

**Modify:** `K/ui/DownloadHistoryScreen.kt`; extract **new** `K/ui/jobs/SourceDownloadDetailScreen.kt`.

- [ ] Use real download record and transfer timeline, title/source, bytes/total when known and meaningful current stage. Unknown totals remain indeterminate.
- [ ] Preserve existing cancel/retry/readiness actions and processing/source errors. Distinguish source download from processed-result download and cloud processing.
- [ ] Completion offers the pipeline's next consent/review step. Do not add this original source to processed-only Library or present it as an offline voice result.
- [ ] Keep copy/open-source actions only where currently supported. No invented bandwidth, remaining-time or progress estimates.

**Acceptance:** individual transfer remains inspectable from Home and progresses into the proper review flow; it never becomes a false Library result.

## S10 — Library with search, filters, stars and offline results

**Reference:** approved Library B Audio cards. **Owner:** Agent B.

**New:** `K/ui/library/LibraryScreen.kt`, `K/ui/library/LibraryAudioCard.kt`.

- [ ] Use F05 catalog/ViewModel, shared header/wave, search, filter controls, audio cards and mini-player. No profile icon, phone scan, originals or video filter.
- [ ] Expose All, Starred, Downloaded, Not downloaded and Show removed; offer Newest/Title ordering without overcrowding the chosen card composition. Preserve query/filter/scroll on Player or details return.
- [ ] Card shows title, supported duration, star, overflow/info and real offline state. Tapping the main card opens/plays S11. Star and info taps do not trigger playback. Announce star selected state accessibly.
- [ ] Remote-only Play requests the full file; downloading shows real progress; Available offline means validated complete storage. Explicit Download/Keep offline remains discoverable from item actions.
- [ ] No-results offers clear search/filter reset; empty Library explains that completed voice results appear here and links to Home/import. Offline with cached entries preserves browsing and play. Removed filter exposes Restore using F05.
- [ ] Use stable item keys and lazy rendering. Wave phase and playback position must not rebuild the entire catalog every frame/tick.

**Acceptance:** offline restart shows saved processed entries and local search/star/filter work; card taps, star and info remain independent. Add focused projection tests in F05 rather than duplicating catalog rules here.

## S11 — Full audio player and compact audio layout

**Reference:** approved Player A Wave card; board 07 C interpreted as compact **audio-only** adaptation. **Owner:** Agent B.

**New:** `K/ui/player/PlayerScreen.kt`, `K/ui/player/MiniPlayer.kt`.

- [ ] Build title, shared animated wave card, seek control with real elapsed/duration and previous/play/next. Add shuffle, repeat off/all/one, auto-next and queue controls with clear selected states.
- [ ] Use the single service/controller state. Seeking and play/pause from this screen, mini-player or system controls remain synchronized. Show preparation/buffering/failure separately; do not advance the visual seek bar while stopped because a decorative wave moves.
- [ ] Miniplayer shows actual current track and play/pause, opens full Player and stays above tab navigation. Use board 07 C compact proportions for constrained audio presentation only; no video surface, fullscreen-video controls or second full Player design.
- [ ] Queue opens S12; info opens S13. Preserve playback across tab changes and full-player dismissal. Back returns to the correct originating page without resetting queue.
- [ ] When offline, cached tracks play completely; unavailable explicit selections explain that download requires connection. Track removal/deletion and account change update current state safely through F07.
- [ ] Stop decorative waves in background or disabled-motion mode while audio service continues. Display static fallback if necessary; do not read amplitude from network audio to draw the approved decorative wave.

**Acceptance:** queue/seek/repeat/shuffle are consistent across all surfaces; no video UI exists; one Media3 session plays the full cached file offline. F07 owns rule tests; runtime controls require authorized Android verification.

## S12 — Expanded queue sheet

**Reference:** board 06 A. **Owner:** Agent B.

**New:** `K/ui/player/PlaybackQueueSheet.kt`.

- [ ] Shared sheet displays actual ordered queue, current indicator and availability. Scroll to current item when sensible without overriding the user's active scroll.
- [ ] Selecting an item changes the same service queue index; preserve repeat/shuffle/auto-next choices. Display active shuffle order consistently with F07.
- [ ] Expose agreed queue controls and close action; do not invent playlists, collaborative queues or drag reorder from incidental art. Include accessible labels for repeat off/all/one.
- [ ] Show bounded-skip/offline feedback without covering all items; empty queue offers close/Library navigation.

**Acceptance:** opening/dismissing does not recreate the queue or pause playback; selection and system next reflect the same ordered tracks.

## S13 — Track details: Media/Job tabs

**Reference:** approved details C. **Owner:** Agent B.

**New:** `K/ui/library/TrackDetailsScreen.kt`.

- [ ] Shared header/wave with Media and Job tabs; preserve selected tab/scroll on transient navigation. No profile icon.
- [ ] Media shows real title/duration/file availability and available metadata. Actions open Player, Keep offline, Save a copy, Share or S14 as appropriate. Avoid exposing private absolute file paths or signed URLs.
- [ ] Job shows the originating job ID/status/timing/source information from persisted snapshot, refreshable online. Every normal Library item is processed and linked; if older metadata is missing, show unavailable job info with retry rather than fabricate it.
- [ ] File inspection and detail refresh must not implicitly acquire remote output. Show offline/stale job metadata while keeping local playback/actions usable.

**Acceptance:** item info always opens the correct job; offline media and cached job details remain inspectable; absent metadata is clearly unavailable.

## S14 — Rename, local removal/restoration and cloud deletion

**Reference:** board 16 B rename sheet, board 17 B delete sheet. **Owner:** Agent B.

**New:** `K/ui/library/RenameAudioSheet.kt`, `K/ui/library/DeleteAudioSheet.kt`; use shared actions for local hide/restore. Coordinator wires job-screen callers to these components.

- [ ] Rename shows current title in a shared text field, validates using existing rules, handles busy/error/keyboard and calls the existing rename operation. Update Library, Home, detail and queue metadata consistently after success.
- [ ] Keep network-required rename behavior truthful offline; do not invent a cloud mutation outbox. Existing local operation rename follows its current supported behavior.
- [ ] Label Remove from Library explicitly as local hiding. Use F05 persistent hidden flag and provide Restore through Show removed. It does not delete cloud audio, downloaded file or job history.
- [ ] Delete sheet clearly says it removes audio from the account and private app storage, while separately saved/shared copies remain. Use semantic destructive color and existing confirmation/request safeguards.
- [ ] Apply confirmed deletion to Library, queued/current track and private storage through the shared coordinator. On failed/uncertain cloud deletion, retain truthful state/retry; never report cloud deletion completed solely because a card was hidden.

**Acceptance:** local hide and destructive delete cannot be confused; rename updates every surface; delete-current-track stops/removes it without a stale mini-player. Add orchestration tests for these cross-surface updates.

## S15 — Settings and language

**Reference:** Settings C. **Owner:** Coordinator.

**New:** `K/ui/settings/SettingsScreen.kt`. **Modify:** Settings host in `K/ui/VocalApp.kt`.

- [ ] First item is Profile with current account summary, followed by Accent/theme entry and inline System/English/Arabic language choices, then About and existing applicable information.
- [ ] Remove light/system appearance mode controls. System remains a language option only. Do not add unapproved notification/passkey settings from generated backgrounds.
- [ ] Apply language preference through existing mechanism; mirror layout and directional motion correctly. Persist selection after restart without restarting audio unnecessarily.
- [ ] Keep version/build informational without a misleading chevron. Shared mini-player remains if playback exists.

**Acceptance:** Profile is the first Settings row and absent from every other page header; theme mode cannot become light; all language options work with current persistence.

## S16 — Custom accent Palette A

**Reference:** approved color picker A. **Owner:** Coordinator.

**New:** `K/ui/settings/AccentPickerScreen.kt`.

- [ ] Present preset swatches and custom color input/picker with selected-state semantics; use F02 palette generation and validation.
- [ ] Provide a live preview of representative card/button/wave states and a clear Apply action. Back/cancel restores the previously committed accent; apply persists one value. Reset to default selects `#FF814A` through the same flow.
- [ ] Support arbitrary valid opaque sRGB input, including very light/dark colors, with derived legible text roles. Validate malformed hex inline; no raw parse crashes.
- [ ] Recolor all shared primary roles/waves while leaving error/destructive semantics intact. Do not create per-screen accent preferences.

**Acceptance:** custom accent survives restart and appears consistently on auth, Home, Library, Player and sheets. Contrast is covered in F02 tests.

## S17 — Compact Profile and email verification sheet

**Reference:** Profile C, board 08 C. **Owner:** Agent C.

**Modify:** `K/ui/auth/AccountScreen.kt`. **New:** `K/ui/auth/EmailVerificationSheet.kt`.

- [ ] Compact identity card with full name when known, email and truthful verification/access state. Include Login methods, Devices, Refresh, existing account deletion and sign-out actions, plus real legal/account links.
- [ ] Open verification sheet from unverified state; display existing resend cooldown, Send, Check again, busy and real outcomes. Returning from mail/foreground refreshes via current coordinator, not a fake timer declaring verification.
- [ ] Show offline cached account identity with network-required actions explained. Processing restriction/update action uses real state; no invented account tier or benefit.
- [ ] Preserve current-device sign-out behavior. Route global sign-out to S20 and deletion to S22. Known account removal/revocation must leave private playback through shared cleanup.

**Acceptance:** identity and verification are accurate; cooldown/resend cannot duplicate; missing name has a clean fallback; sign-out stops private session.

## S18 — Connection methods and disconnect sheet

**Reference:** methods B Simple list, board 12 B. **Owner:** Agent C.

**Modify:** `K/ui/auth/LinkedMethodsScreen.kt`. **New:** `K/ui/auth/DisconnectMethodSheet.kt`.

- [ ] Simple provider rows with actual linked/unlinked status and supported actions. Preserve PASSWORD/GOOGLE behavior; already-linked Apple follows existing Android limitations, not a new Apple signup button.
- [ ] Add password opens S19; Google connects through the native chooser/current coordinator. Surface cancellation without a false error/success.
- [ ] Disconnect sheet names the provider and consequences, then invokes existing unlink checks/reauthentication. Prevent removal of the final available sign-in method.
- [ ] Update linked status only after authoritative success and guard account switches while requests are in flight.

**Acceptance:** last-method protections hold, provider-specific reauthentication is preserved and no unsupported connection method is introduced.

## S19 — Reauthentication and add-password cards

**Reference:** boards 10 C and 11 C full-page cards. **Owner:** Agent C.

**New:** `K/ui/auth/ReauthenticationScreen.kt`, `K/ui/auth/AddPasswordScreen.kt`; extract existing forms from `LinkedMethodsScreen`/account flow as appropriate.

- [ ] Use shared auth card, wave and provider-specific current-credential prompt. Never ask a Google-only user for a nonexistent password; use the native provider reauth path.
- [ ] Add-password screen includes only fields required by current link flow, with new/confirm matching and existing password policy. Keep reauth and link state separate so retry does not repeat successful mutations unnecessarily.
- [ ] Preserve the originating sensitive action and return once with a valid fresh-auth result. Cancellation must not execute the original destructive action.
- [ ] Keep secrets out of durable state/logging and handle expired/revoked credentials, network errors, busy state and account switch.

**Acceptance:** fresh auth authorizes only the intended current-session operation; cancellation and stale results cannot trigger unlink/delete.

## S20 — Grouped Devices and global sign-out sheet

**Reference:** Devices C, board 15 B. **Owner:** Agent C.

**Modify:** `K/ui/auth/DevicesScreen.kt`; **new** `K/ui/auth/SignOutAllSheet.kt`.

- [ ] Group current installation separately from other devices. Display actual model/platform/OS/app build/last-seen fields with graceful missing data; keep Refresh and Load more.
- [ ] Retain read-only device rows. Do not infer individual revoke/remove capability from artwork.
- [ ] Global sign-out uses B confirmation sheet, real consequences and existing authenticated coordinator method. Handle busy/failure/success and resulting local session cleanup as current behavior dictates.
- [ ] Pagination/refresh errors retain existing device rows. Cached data is marked appropriately offline, with no invented device activity.

**Acceptance:** current installation identification is correct, no per-device revoke appears, and global sign-out reflects real server outcome.

## S21 — Account recovery request and status

**Reference:** board 09 A request card, board 23 C pending steps. **Owner:** Agent C.

**Modify:** `K/ui/auth/AccountRecoveryScreen.kt`.

- [ ] Request card explains real recovery eligibility/deadline and optional reason with existing 500-character limit. Preserve request validation, busy state and sign-out.
- [ ] Pending presentation uses steps, actual status and Refresh. Preserve existing lifecycle-aware polling behavior; do not create another timer per Composable or continue hidden/background polling unnecessarily.
- [ ] Pending suppresses duplicate submission. Rejected shows actual reason; expired removes submission; approved refreshes access via the coordinator.
- [ ] No promised decision date, fake progress percentage or guaranteed review duration. Unknown dates are omitted, not filled from artwork.

**Acceptance:** every real recovery status maps to a truthful screen and repeated updates do not resubmit requests or bypass account gates.

## S22 — Account deletion review and final confirmation

**Reference:** board 13 B sections, board 14 A dialog. **Owner:** Agent C.

**Modify:** `K/ui/auth/AccountScreen.kt`; **new** `K/ui/auth/AccountDeletionReviewScreen.kt`, `K/ui/auth/AccountDeletionDialog.kt`.

- [ ] Review sections describe actual account/cloud input/vocal output/history/device deletion scope, immediate access loss, existing three-month recovery period and eventual cleanup. Distinguish private files from originals and exported/shared copies.
- [ ] Preserve required provider reauthentication via S19 and final explicit confirmation. Use semantic destructive style, readable text and accessible focus.
- [ ] Execute existing durable deletion request/receipt/journal logic exactly once. Show unconfirmed/deferred-cleanup states truthfully; cancellation never erases a confirmed receipt.
- [ ] Ensure new Library flags/queue/private output cleanup participates in F06 and existing recovery rules. UI must not merely navigate away and call it deleted.

**Acceptance:** review → fresh auth → final confirmation → durable outcome remains intact; existing account deletion tests stay passing, with new Library cleanup coverage.

## S23 — About workflow presentation

**Reference:** board 18 C. **Owner:** Coordinator.

**New:** `K/ui/settings/AboutScreen.kt`; move stale About content out of `VocalApp.kt`.

- [ ] Explain implemented workflow: choose/import source, review cloud-processing disclosure, process vocals, then keep/play processed results offline after download.
- [ ] State local versus private cloud behavior accurately. Remove old coming-later/no-cloud copy that contradicts implementation.
- [ ] Show real version/build, existing support/privacy/terms links and concise app identity. Keep native URL opening and actual destinations; no generated sample addresses.
- [ ] Use shared cards/wave and accessible readable copy, with no extra profile shortcut.

**Acceptance:** every statement and link matches actual app behavior/configuration; no promised future feature or fake version appears.

## S24 — Required/optional update and compact progress

**Reference:** board 19 A blocking card, board 20 C inline banner, board 22 C progress. **Owner:** Coordinator.

**Modify:** `K/updates/UpdateGate.kt`. **New if extraction helps:** `K/updates/UpdatePresentation.kt`.

- [ ] Required card blocks app content per current policy; no close/back control may expose blocked routes. Preserve Check again/Update now/error choices from actual state.
- [ ] Optional update is an inline banner inside the existing page composition, with permitted Later/dismiss handling. Preserve current scroll/player context and selected page layout.
- [ ] Compact progress renders actual downloading bytes/percent, verifying, waiting-install and Play-store handoff states. Unknown duration is indeterminate; canceling acquisition does not bypass a required gate.
- [ ] Preserve direct versus play distribution, verification/install protection, retry and real installed/required version data. Do not change server release enforcement.
- [ ] Test presentation mapping for None/Optional/Required and acquisition failure/retry/cancel; keep existing update policy/store tests. Native installer UI remains native.

**Acceptance:** all real update states are represented and none of the new navigation/sheet actions bypass mandatory policy.

## S25 — Shared states in context and native handoffs

**Reference:** board 21 contextual C/B. **Owner:** Coordinator, with each lane correcting its own screen.

**Modify:** each screen's shared feedback call sites; `K/ui/design/CreativeFeedback.kt` only for a proven shared gap.

- [ ] Audit loading, empty, error, success, expired session, offline and permissions across all screens. Use centered C for otherwise empty surfaces and inline B where content exists; preserve each selected composition.
- [ ] Keep action progress attached to that action, job progress inside its card/timeline and pagination errors in list footers. Avoid replacing an entire populated Library with a spinner on refresh.
- [ ] Keep text concrete and actionable: missing local file, invalid media, host offline, storage unavailable and network-required action use actual reason mapping.
- [ ] Check document import/export, Android share, Google chooser, optional notification permission and installer handoffs. Preserve cancellation/state on return and use native platform UI.
- [ ] Audit no double navigation/submission from rapid taps, rotation, returning from external activities or task status changes. Stable semantics tags allow later UI automation.

**Acceptance:** every selected page retains its design under state changes and platform handoffs leave consistent app state.

## Runtime acceptance matrix

Run only after the user explicitly authorizes an Android target. Current iOS-only simulator permission cannot provide this proof. Record target/build and actual observed outcomes; do not install/uninstall or replace device data outside authorization.

| Area                    | Scenario                                                                         | Required observation                                                            |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Offline core            | Download full voice result, airplane mode, play to end and seek near end         | Complete local playback without server/token/download calls                     |
| Offline restart         | Kill/relaunch app; also reboot target while offline                              | Same signed-in owner's catalog and full audio remain available                  |
| Remote-only offline     | Tap an undownloaded result offline                                               | Clear need-to-download message; no false offline badge                          |
| Interrupted acquisition | Interrupt download/process, reopen                                               | Partial is never playable/Available offline; safe explicit retry                |
| Offline queue           | Mix available/unavailable items, shuffle/repeat/auto-next combinations           | Bounded skip/stop, no loop or wrong-owner playback                              |
| Background              | Lock screen, leave app, use system controls/headphone unplug                     | Correct single media session, expected focus behavior, no decorative UI work    |
| Identity                | Sign out/switch account during download/playback                                 | Old private playback stops, no old catalog/file exposed                         |
| Deletion                | Delete playing audio and test account deletion cleanup in safe test account      | Correct cloud outcome handling and local queue/file cleanup                     |
| Theme/motion            | Several custom accents, navigate/sheets/presses; disable system animations       | Legible consistent dark theme, A motion/static fallback, no stuck presses       |
| Performance             | Representative low-resource authorized device, long Library, repeated navigation | Profile frame timing/memory; no growing retained screens or offscreen wave work |
| Accessibility           | Arabic RTL, largest practical font, TalkBack, keyboard, landscape                | Controls reachable/readable, correct order/labels, no clipped confirmation      |
| Auth/account            | Register/name retry, reset, verify, link/unlink, recovery                        | Existing security gates and real feedback preserved                             |
| Updates                 | Direct/play optional/required/progress/error return paths                        | No mandatory gate bypass or false install success                               |

Use actual measurements for performance: inspect janky frames against the target refresh interval (16.7 ms at 60 Hz), compare animated/static idle CPU and memory after repeated navigation, and investigate sustained allocations/leaks. These are evaluation criteria, not a promise that every device will meet a fixed budget. Keep measured results separate from previews and JVM/build validation.
