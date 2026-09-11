# Full MusicMute dashboard task plans

Planning date: 2026-09-10. Stack corrected on 2026-09-11 to React + TypeScript + Vite. B01–B18 and D01–D14 are implemented and locally validated; provider and deployment boundaries are recorded separately.

The user selected React + TypeScript + Vite for the web dashboard. The backend-first B18 gate passed before dashboard implementation began.

- [Backend API tasks](backend/README.md): 18 ordered tasks.
- [Dashboard tasks](dashboard/README.md): 14 ordered tasks.
- [Approved scope and permissions](scope.md).
- [Shared API contracts](contracts.md).

## Execution rules

When separately authorized, use superpowers:executing-plans with checkpoints. Read the scope, contracts, task and applicable AGENTS.md before editing. Reinspect source and existing plans because this checkout has extensive unrelated work in progress. Do not reset/stash/delete/rewrite another task's work.

1. Complete backend B01–B18 first.
2. B18 validates APIs, permission matrix, races, compiled runtime and documented contracts.
3. Only after that gate, start dashboard D01–D14.
4. Each task carries files/responsibility, interfaces, dependency links, actionable checkboxes, specific behavioral scenarios, validation commands and completion evidence.
5. For meaningful implementation changes, encode listed acceptance scenarios as failing tests before fixing behavior. Test snippets/scenarios are specifications, not test results.
6. Keep task status NOT STARTED until execution actually begins; mark complete only after its observable acceptance and required checks pass. Record blockers instead of claiming skipped checks pass.
7. Local tests use synthetic accounts/media and isolated MongoDB/Redis/Firebase fixtures. No production endpoints or user recordings in test fixtures.
8. No commits, pushes, published releases, deployment, hosted assets, domain/server routing or cloud configuration changes. APK verifier local runtime documentation is in scope; hosting is managed entirely by the user.
9. Dashboard tests use Vitest, React Testing Library/MSW and Playwright desktop browsers at responsive viewport widths 360/768/1440. Any separately requested mobile/device UI testing uses only the existing iPhone 17 Pro iOS 26.0 simulator `$IOS_SIMULATOR_UDID`; do not substitute another target if unavailable. Real configured Google/S3 browser proof is separate, and synthetic fixtures do not imply physical Windows/mobile proof.
10. Formatting is scoped to files changed by this work; broad formatter scripts must not rewrite unrelated edits. Review the diff before completion.

## Delivery phases

| Phase                       | Backend tasks | Result                                                                    |
| --------------------------- | ------------- | ------------------------------------------------------------------------- |
| Identity and accountability | B01–B03       | Verified Google admission, role permissions, owner access, audit/receipts |
| Fleet                       | B04–B05       | Per-machine authority, real admin controls and safe recovery              |
| Processing operations       | B06–B10       | Settings, users, jobs/actions and private audio grants                    |
| App releases                | B11–B14       | Drafts, verified APKs, publication/withdrawal and client admission        |
| Visibility and API gate     | B15–B18       | Metrics, health/alerts, CSV and complete backend handoff                  |

| Phase                       | Dashboard tasks | Result                                                        |
| --------------------------- | --------------- | ------------------------------------------------------------- |
| Foundation/access           | D01–D02         | Local package, UI/session/client and owner access             |
| Operations                  | D03–D08         | Overview, workers, jobs, users and audio preview/download     |
| Releases/settings           | D09–D11         | APK drafts, policy preview/publication and maintenance/limits |
| Visibility and verification | D12–D14         | Health/alerts, activity/export and full local validation      |

## Existing plan reconciliation

Do not execute overlapping tasks twice. These new tasks own the full dashboard/API integration; read and reuse existing approved detail and any implemented code.

| Existing work                                                                                    | New owner / relationship                                                                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [UPD backend B01](../../superpowers/plans/2026-09-10-app-updates-backend.md) admin allowlist     | B01–B03 replace equal access with one role-based registry                                                        |
| UPD backend B02                                                                                  | B11 release model/public compatibility                                                                           |
| UPD backend B03                                                                                  | B12 S3 upload and APK inspection                                                                                 |
| UPD backend B04                                                                                  | B13 preview/publication/withdrawal/download                                                                      |
| UPD backend B05                                                                                  | B14 new-submission update enforcement                                                                            |
| UPD backend B06                                                                                  | B12 local verifier requirements and B18 API docs only; hosting/package modifications excluded                    |
| [UPD dashboard D01–D03](../../superpowers/plans/2026-09-10-app-updates-dashboard.md)             | D01–D02 and D09–D10; no duplicate shell/access store                                                             |
| [Multi-machine backend design/plan](../../superpowers/plans/2026-09-10-multi-machine-workers.md) | B04–B05 and D04–D05; use its ownership/recovery detail, latest user instruction makes this package backend-first |
| [Android update plan](../../superpowers/plans/2026-09-10-app-updates-android.md)                 | Separate mobile implementation owner; consume B11–B14, do not recreate tasks here                                |
| [iOS update plan](../../superpowers/plans/2026-09-10-app-updates-ios.md)                         | Separate mobile implementation owner; consume B11–B14                                                            |
| Existing job cancel/retry/account deletion                                                       | Reuse domain state machine and fences in B06–B10; no new admin hard-delete flow                                  |

## Requirement coverage

| Accepted requirement                                      | Backend                                            | Dashboard                  |
| --------------------------------------------------------- | -------------------------------------------------- | -------------------------- |
| Google sign-in, initial owner, expandable roles           | B01–B03                                            | D01–D02                    |
| Overview/date statistics                                  | B15                                                | D03                        |
| Workers/register/keys/drain/enable/revoke/recover         | B04–B05                                            | D04–D05                    |
| FIFO jobs/stages/cancel/eligible retry                    | B08–B09                                            | D06                        |
| User search and processing-only suspension                | B06–B07                                            | D07                        |
| Admin playback and download of input/result               | B10                                                | D08                        |
| APK upload/signature verification/English changelog       | B11–B12                                            | D09                        |
| Android direct/Play and iOS policy publication/withdrawal | B13–B14                                            | D10                        |
| Limits, maintenance and preserved existing work           | B06, B09, B14                                      | D11                        |
| Dashboard-only alerts, system health                      | B16                                                | D12                        |
| Audit and non-personal CSV exports                        | B02, B17                                           | D13                        |
| English, light/dark, responsive/accessible UX             | B18 typed/error contracts                          | D01, all pages, D14        |
| No automatic retention deletion                           | B02, B06, B11, B16                                 | No delete-history controls |
| Backend-first verification                                | B18                                                | D01 gate, D14 final checks |
| Mobile checks/force gate/24-hour reminders                | B11–B14 contracts; linked mobile plans own runtime | D10 explanatory preview    |
| Hosting handled by user                                   | Excluded                                           | Excluded                   |

## Validation of this planning package

Planning validation checks Markdown formatting, relative links, task counts/IDs, dependency acyclicity, required sections, unchecked status and approved-scope coverage. No application code or tests are run simply to write plans.

Future completion report must distinguish unit/HTTP mocks, compiled isolated integration, real local APK tools, browser fixture proof, live S3/Firebase, physical Windows and mobile UI proof. Preserve those boundaries even if all local tests pass.
