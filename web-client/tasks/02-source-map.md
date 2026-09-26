# Source inspection map

Paths below are relative to the worktree root. Inspect actual source before
coding; existing README claims about processing availability can be older than
current source/configuration. Do not treat production as a test fixture.

## Repository and API

Read `README.md`, `CONTRIBUTING.md`, `backend/AGENTS.md`, `backend/README.md`,
`backend/package.json`, `dashboard/README.md`, `dashboard/package.json`, relevant
configuration and lockfiles, `android/README.md`, `android/app/build.gradle.kts`,
`docs/api/client-contract.md`, and `backend/openapi.yaml`.
Some older READMEs link to task documents absent from this base; inspect existing
source instead of inventing their contents.

Inspect these backend directories: `src/auth`, `src/users`, `src/devices`,
`src/app-policy`, `src/jobs`, `src/url-imports`, `src/admin-settings`, and the
storage/processing admission modules they call. Search for every platform enum,
platform-indexed policy lookup, push-target selection, and device presenter.
Inspect `backend/test` auth, devices, app-policy, job, URL-import, quota and
account recovery integration suites. Follow existing fixture patterns.

## Android reference

Prefix for paths in this section:
`android/app/src/main/java/com/hatem/musicmute/`.

| Area                     | Source starting points                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation and app state | `MainActivity.kt`, `VocalApplication.kt`, `ui/VocalApp.kt`, `state/`                                                                                                                   |
| Identity and account     | `auth/AuthSessionCoordinator.kt`, `auth/AuthApiClient.kt`, `auth/AuthModels.kt`, `auth/FirebaseAuthGateway.kt`, `ui/auth/`                                                             |
| Theme                    | `ui/Theme.kt`, `ui/Typography.kt`, `ui/design/AccentPalette.kt`, `CreativeTokens.kt`, `CreativeComponents.kt`, `CreativeMotion.kt`, `CreativeWave.kt` in `ui/design/`                  |
| Home and review          | `ui/home/HomeScreen.kt`, `ui/importing/ImportReviewSheet.kt`                                                                                                                           |
| Jobs/results             | `ui/ProcessingHistoryScreen.kt`, `ui/ProcessingDetailScreen.kt`, `ui/jobs/`, `ui/AudioTaskCard.kt`, `ui/AudioStepTimeline.kt`                                                          |
| Intake and wire calls    | `processing/JobsApiClient.kt`, `UrlImports.kt`, `JobModels.kt`, `ProcessingMediaPolicy.kt`, `AudioInputPreparer.kt`, `AudioPreparationEngine.kt`, `S3FormUploader.kt` in `processing/` |
| Library/player           | `library/LibraryModels.kt`, `library/DefaultLibraryRepository.kt`, `ui/library/LibraryScreen.kt`, `ui/player/`, `playback/`                                                            |
| Settings                 | `ui/settings/SettingsScreen.kt`, `ui/settings/AccentPickerScreen.kt`                                                                                                                   |

Inspect English and Arabic resources under `android/app/src/main/res/values/`
and `values-ar/`, plus font/drawable assets. Inventory every relevant screen,
modal, action, and loading/empty/error state. Record the mapping in a new
`web-client/tasks/parity-matrix.md` during Task 01, with source, web destination,
status, test evidence, and intentional browser adaptation.

## Existing browser patterns

Read `dashboard/src/config.ts`, `dashboard/src/api/api-client.ts`,
`dashboard/src/api/wire-case.ts`, its Firebase/auth code, test setup, Playwright
configuration, `dashboard/server.mjs`, and packaging scripts. Adapt only useful
patterns into the new folder, preserving end-user rather than admin semantics.
