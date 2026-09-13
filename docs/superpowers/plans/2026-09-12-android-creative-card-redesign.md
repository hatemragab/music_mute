# Android Creative Card Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the entire Android app consistently around the approved Creative Card selections, with reusable calm motion and complete offline playback of downloaded processed voice results.

**Architecture:** Extend the existing Kotlin/Compose, StateFlow/DataStore and Media3 architecture. Build shared foundations first, then feature screens consuming stable contracts. Preserve existing auth, processing, download and update services. One Library catalog and one media session serve all audio surfaces.

**Tech Stack:** Existing Kotlin 2.2.20, Compose BOM 2025.09.01, Media3 1.8.0, coroutines, DataStore, Firebase Auth and Gradle direct/play variants. Versions describe inspected source, not an upgrade request.

**Spec:** [Approved decisions and behavior](../../design/creative-card/ANDROID-REDESIGN-SPEC.md)

## Global constraints

- The plan was written before application edits. Implementation was subsequently authorized on 2026-09-13; see [current implementation status](2026-09-12-android-creative-card/IMPLEMENTATION-STATUS.md).
- Android only. No backend, dashboard or iOS changes. Do not commit, push, publish, deploy or delete user data without explicit instruction.
- Preserve unrelated edits; inspect the current worktree before implementation. Do not stash/reset another writer's work.
- Dark only, customizable accent, Profile first in Settings and absent from other headers. All recommended A motion. No video or phone-wide Library.
- Complete files in durable private storage are mandatory for offline playback. Keep action-triggered retrieval and owner/session fencing.
- Reuse existing dependencies. Do not add another playback engine, database or navigation framework to implement a visual redesign.
- Paths in task sheets are repository-relative. `K` = `android/app/src/main/java/com/hatem/musicmute`; `T` = `android/app/src/test/java/com/hatem/musicmute`. New paths are explicitly marked **new**; existing paths are modified only when needed.
- UI instrumentation/profiling remains pending an authorized Android target. The user's only authorized simulator is iPhone 17 Pro iOS 26.0 (`3CC14436-EC3C-4419-A079-C84951E5FA07`), which cannot execute this native Android app. Do not silently choose another device.

## Phase 1 — shared logic, design, motion and widgets FIRST

Execute the detailed [shared foundation tasks](2026-09-12-android-creative-card/shared-foundations.md) in this order. Each task owns implementation plus focused checks; do not create screen-specific duplicates.

| ID | Deliverable | Depends on |
|---|---|---|
| F01 | Source baseline, domain contracts and migration map | None |
| F02 | Dark tokens, accent persistence and accessibility | F01 |
| F03 | Shared lifecycle-aware A motion and Canvas wave | F02 |
| F04 | Shared cards, forms, sheets, feedback and adaptive shell | F02, F03 |
| F05 | Processed-result catalog, search/star/filter persistence | F01 |
| F06 | Durable full-file offline acquisition and restore | F05 |
| F07 | Single Media3 queue/session and playback settings | F06 |
| F08 | Auth/account adapters, full name and action contracts | F01 |
| F09 | Route/state integration and foundation acceptance gate | F04–F08 |

## Phase 2 — all app screens AFTER the shared gate

The [screen task sheet](2026-09-12-android-creative-card/screens.md) contains layout, behavior, dependencies, state coverage and acceptance for every surface.

| ID | Screen/task | Selection |
|---|---|---|
| S01 | Login | Creative Card auth |
| S02 | Create account with full name | Creative Card auth |
| S03 | Forgot password | Creative Card auth |
| S04 | Home jobs | A Compact |
| S05 | Import review | 01 C sheet |
| S06 | YouTube link and confirmation | 02 C / 03 B |
| S07 | Active job details | 04 A timeline |
| S08 | Completed result | 05 C timeline |
| S09 | Source download details | 24 B timeline |
| S10 | Library | B Audio cards |
| S11 | Player and compact audio adaptation | A Wave card; 07 C audio-only layout |
| S12 | Expanded queue | 06 A sheet |
| S13 | Track details | C Media/Job tabs |
| S14 | Rename, local hide/restore and delete audio | 16 B / 17 B sheets |
| S15 | Settings and language | C |
| S16 | Accent picker | A Palette |
| S17 | Profile and verification | C Compact / 08 C sheet |
| S18 | Connection methods and disconnect | B list / 12 B sheet |
| S19 | Reauthentication and add password | 10 C / 11 C cards |
| S20 | Devices and global sign-out | C Grouped / 15 B sheet |
| S21 | Account recovery request and status | 09 A / 23 C |
| S22 | Account deletion review and final dialog | 13 B / 14 A |
| S23 | About | 18 C |
| S24 | Required/optional update and progress | 19 A / 20 C / 22 C |
| S25 | Shared state placement and platform handoffs | 21 contextual C/B |

## Phase 3 — parallel screen execution rules

After F09 passes, launch screen agents to accelerate implementation. Do not launch them before shared widgets, animations, offline/player logic and contracts are working. This is a future execution instruction; no implementation agents are launched by writing this plan.

Use up to three screen workers plus the coordinator, respecting the available four total agent slots. Assign one task at a time within each lane so progress remains reviewable:

| Lane | Tasks | Exclusive screen ownership |
|---|---|---|
| Agent A: intake/jobs | S04–S09 | `K/ui/home/`, `K/ui/importing/`, `K/ui/jobs/`; existing `ProcessingDetailScreen.kt`, `AudioStepTimeline.kt`, `DownloadHistoryScreen.kt` adapters |
| Agent B: Library/player | S10–S14 | `K/ui/library/`, `K/ui/player/` |
| Agent C: auth/account | S01–S03, S17–S22 | `K/ui/auth/` screen files; consumes frozen coordinator APIs |
| Coordinator | S15, S16, S23–S25; integration | `K/ui/settings/`, `K/updates/UpdateGate.kt`, navigation, `VocalApp.kt`, `MainActivity.kt`, `VocalApplication.kt`, shared/theme/domain files and shared resources |

The coordinator owns all Gradle, manifest and translation file edits. Workers deliver a table of required English/Arabic keys and usages with their patch; coordinator integrates keys before compiling that lane. Reserve prefixes `creative_home_`, `creative_library_`, `creative_account_`, `creative_settings_`, `creative_update_`; reuse existing strings when accurate. Avoid temporary untranslated user-facing strings in the final tree.

Each worker instruction must state: **You are not alone in this codebase. Preserve other edits, stay within assigned files, and adapt to the frozen shared contracts. Request a coordinator change for shared APIs rather than creating a competing implementation.** Include the relevant approved board, spec section, task IDs and test commands. No worker may modify backend/dashboard/iOS, start devices, commit or push.

Shared contract changes go through the coordinator, who informs every affected lane and reruns affected checks. On completion each worker reports changed files, states covered, tests actually run and unresolved limitations. Integrate one lane at a time, review diffs and check that the other lanes still compile. Reassign an idle worker only to a bounded independent task with fresh ownership; do not have two agents edit the same screen.

## Phase 4 — integration and acceptance

- [ ] Review the complete selection matrix against final screens; keep board 07 explicitly audio only and board 21 contextual.
- [ ] Verify every user path: login/register/reset, import/YouTube, Home jobs/result, Library/player/queue/details, account lifecycle, settings and updates.
- [ ] Verify owner-scoped metadata and downloaded audio survive restart without cloud calls; originals are absent from Library.
- [ ] Run focused JVM suites after their owning changes, then the full direct/play validation once integrated:

```sh
cd /Users/hatemragap/work_spaces/music_remover/android
ANDROID_HOME=/Users/hatemragap/Library/Android/sdk ./gradlew \
  :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest \
  :app:lintDirectDebug :app:lintPlayDebug \
  :app:assembleDirectDebug :app:assemblePlayDebug
```

- [ ] Use the repository's existing Kotlin formatting/check configuration if present at execution time. Do not run Flutter commands for this native Android implementation or add a formatter dependency solely for the redesign. Run `git diff --check` and review the diff for accidental changes.
- [ ] Compile representative Compose previews for selected states. Preview rendering/static inspection is not device proof.
- [ ] When an Android target is explicitly authorized, perform the [runtime acceptance matrix](2026-09-12-android-creative-card/screens.md#runtime-acceptance-matrix). Until then, label runtime, cold-start offline and performance proof unverified.
- [ ] Confirm no per-frame network/disk work, no duplicate media players, no persistent animations on hidden pages, no update/auth bypass and no new device media scanning permissions.
- [ ] Report implementation, exact files and actual commands/results separately from device or production proof. Do not claim completion of Android runtime acceptance from JVM tests alone.

## Planning deliverable review

The plan must cover nine shared tasks, 25 screen tasks, all 24 numbered selections, earlier primary-page selections, all A motion, custom accent, processed-only Library, full offline playback and future agent ownership. Source changes proposed here are not claims that features already exist.
