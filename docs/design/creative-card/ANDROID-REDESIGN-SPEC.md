# Approved Android Creative Card redesign

Status: design approved on 2026-09-12; implementation authorized and in progress on 2026-09-13. This document supersedes unresolved questions and incidental image details in the earlier gallery. Actual implementation evidence is recorded in the [checkpoint](../../superpowers/plans/2026-09-12-android-creative-card/IMPLEMENTATION-STATUS.md).

## Scope and precedence

Implement only the native Android app. Preserve backend, dashboard and iOS source and contracts. Use Kotlin, Jetpack Compose and the existing Media3 player. Build responsive shared components; do not copy phone screenshots into the app. Written requirements here take precedence over generated artwork. Actual API capabilities and security rules take precedence over illustrative buttons and text.

Use one Creative Card dark theme. Remove light/system appearance choices. Preserve system/English/Arabic language choices and RTL. Keep the approved preview accent orange `#FF814A` as the default; allow preset and custom primary colors through Palette A. Error/destructive colors remain semantic colors. No profile icon appears in other page headers: Profile is the first Settings item.

## Main screen selections

| Screen | Approved direction | Required behavior |
|---|---|---|
| Login | Creative Card auth board | Email/password and existing Google sign-in; registration/reset navigation |
| Create account | Creative Card auth board | Full name, email, password and confirm password |
| Forgot password | Creative Card auth board | Existing reset flow and request feedback |
| Home | A Compact | Import, secondary YouTube entry, jobs list with Load more inside that list; no recent-audio section |
| Library | B Audio cards | Processed results only, search, filters, stars, offline availability and mini-player |
| Player | A Wave card | Audio only, seeking, previous/next, queue, auto-next, shuffle, repeat off/all/one, background/system controls |
| Track details | C Media/Job tabs | Local availability/media metadata and actual originating job information |
| Settings | C | Profile first, accent entry, inline language choices, About |
| Profile | C Compact | Real account identity/access/verification state and existing account actions |
| Connection methods | B Simple list | Existing provider capabilities and last-method safeguards |
| Devices | C Grouped | Current installation grouping, real metadata, refresh and pagination; read only |
| Accent picker | A Palette | Presets plus custom primary color, persistent and accessible |

References: [saved gallery](GALLERY.md), [motion examples](motion/README.md).

## All 24 numbered selections

| Board | Surface | Selection | Interpretation |
|---|---|---|---|
| 01 | Import review | C | Bottom sheet; preserve rights and private-cloud disclosure |
| 02 | YouTube link | C | Input sheet; validation and explicit continue |
| 03 | YouTube confirmation | B | Confirmation sheet before source download |
| 04 | Active job | A | Timeline with actual progress and valid retry/cancel actions |
| 05 | Completed result | C | Timeline/result presentation with lazy output actions |
| 06 | Expanded playback queue | A | Sheet backed by the single audio session |
| 07 | Former video concept | C layout only | Audio-only compact adaptation inside player presentation; no video page, video filter or second player |
| 08 | Email verification | C | Sheet with resend/check/cooldown states |
| 09 | Account recovery request | A | Card; reason, actual deadline and feedback |
| 10 | Reauthentication | C | Full-page card, provider-aware |
| 11 | Add password sign-in | C | Full-page card |
| 12 | Disconnect method | B | Sheet with actual method safeguards |
| 13 | Account deletion review | B | Sections describing real consequences |
| 14 | Final account deletion | A | Dialog, preserve fresh-auth and durable deletion flow |
| 15 | Sign out all devices | B | Sheet, preserve existing global sign-out semantics |
| 16 | Rename audio | B | Sheet |
| 17 | Delete audio | B | Sheet; explicit cloud/account and private-copy consequences |
| 18 | About | C | Workflow explanation using implemented behavior |
| 19 | Required update | A | Blocking card |
| 20 | Optional update | C | Inline banner |
| 21 | Shared states | Contextual C/B | Preserve selected page structure; C for otherwise empty pages, B inline when content exists |
| 22 | Update progress | C | Compact progress |
| 23 | Recovery pending | C | Steps; no invented approval date |
| 24 | Source download details | B | Actual transfer timeline |

## Library and durable offline playback

Library contains only processed voice results from MusicMute jobs. Original imports and source downloads remain processing inputs, not Library tracks. Do not scan the phone collection or request broad media permissions. Do not add audio/video categories.

A completed result becomes a Library entry automatically from job metadata. Merely opening Home, Library, a detail page, search or decorative waves must not download audio. Play, Download and Share request the complete processed file on demand. The first Play may show a preparation/download state until the complete validated file is saved, then starts playback.

Once acquired, audio must play completely offline, including after app closure, process death and device restart while the same account remains signed in. A streaming buffer or partial download never qualifies. Use the existing durable `noBackupFilesDir/processing/artifacts` owner-scoped repository, not an evictable cache directory. Persist the Library index and user choices. Show **Available offline** only for a present, validated complete file. Do not silently evict downloaded tracks. App uninstall/clear-data and explicit destructive actions naturally remove private files; user exports remain independent.

Reuse cached files before requesting job details or signed URLs. Store neither signed URLs nor access tokens as playback identities. Dedupe concurrent Play/Download/Share acquisition; commit files atomically, clean only attempt-owned partials, preserve valid files on failure, and handle storage exhaustion honestly. A missing/corrupt file clears the offline badge and allows an explicit online retry. Cached playback and local filtering/starring must work without successful cloud refresh.

Preserve account/session isolation and existing deletion/revocation rules. An offline cached bootstrap may restore the same known account; it must never grant a new account access or bypass known deletion, revocation or required-update policy. Signing out immediately stops private playback and clears the visible session/queue; preserve the existing retention/purge rules rather than silently widening access. Account deletion purges that owner's index, preferences, queue and private files through existing durable cleanup.

Offline queue advancement uses available files. Skip unavailable queued tracks once with clear feedback; stop after a bounded traversal if none are playable. Do not spin, silently fetch on a metered/offline failure loop, or show unavailable tracks as downloaded. An explicit tap on an unavailable item offline reports that it needs downloading when connected.

Separate actions clearly:

- **Download / Keep offline:** saves the private full file; does not launch a public export picker.
- **Save a copy:** existing Android document export, independent of the private copy.
- **Share:** ensures the private file, then uses the native share flow.
- **Remove from Library:** local hide only, persisted per account; does not delete the job, cloud audio or downloaded file. A Show removed filter permits restoration and prevents sync from resurrecting hidden entries.
- **Delete audio from account:** existing destructive operation and confirmation; remove local entries/files after confirmed success, using existing recovery behavior on uncertain outcomes. Do not invent a separate job-only delete endpoint.

The local-hide/restoration contract is an implementation default for the requested Library separation; no new cloud feature is implied.

## Motion: all recommended A

| Interaction | Shared motion contract |
|---|---|
| Decorative wave | Approximately 12-second seamless phase cycle, small displacement; accent driven |
| Bottom sheet | Approximately 340 ms open, 300 ms close, cubic easing, no visible overshoot |
| Primary button | Press scale to 0.975 with ripple, return smoothly; no delayed action dispatch |
| Star | Restrained approximately 300 ms state feedback; immediately update accessible selected state |
| Navigation | Approximately 230 ms fade and small logical slide; start with 16 dp, mirror where appropriate in RTL |
| Ordinary rows/toolbars | Standard native ripple/feedback |

Centralize values and animation lifecycle. Native gestures, focus and accessibility remain authoritative. Pause decorative motion when hidden/backgrounded; obey disabled/reduced system motion with a static wave and immediate transitions. Avoid per-frame repository reads, list-wide recomposition, bitmap allocation, blur stacks or one animation clock per row. Actual Android profiling determines final tuning; demo videos do not prove performance.

## Behavior that redesign must preserve

- Rights confirmation and private-cloud disclosure remain before upload; YouTube remains a visible secondary flow with its existing download confirmation. Pasting and previews do not authorize cloud upload.
- Preserve audio input validation, individual job identity, cancellation rules, bounded retry, truthful worker-offline/error states and real timestamps. Unknown progress is indeterminate; duration and processing elapsed are different values.
- Preserve account recovery, verification cooldowns, provider reauthentication, last-method protections, account deletion recovery period and durable deletion journal. Use actual strings/contracts, not sample image copy.
- Required updates remain non-bypassable. Optional banners preserve current content. Do not alter release enforcement or distribution behavior.
- Android owns the document picker, share sheet, Google chooser, permission dialogs and installer. No custom replicas.
- Loading, empty, error and success treatments fit each selected composition. Support keyboard, large text, TalkBack, RTL, landscape and tablet widths.

## Delivery and validation boundary

Implement shared logic, tokens, motion, components and stable state contracts before parallel screen work. The [implementation plan](../../superpowers/plans/2026-09-12-android-creative-card-redesign.md) defines the gate and file ownership.

The user authorized Android implementation with “Now start all do your best.” Android JVM tests, lint and builds are within scope. Existing device instructions permit only the named iOS simulator; that cannot run this native Android app. Android runtime, offline restart and performance proof require an explicitly authorized Android target later. No Android device substitution is authorized by this document.
