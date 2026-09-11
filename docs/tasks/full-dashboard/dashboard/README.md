# Dashboard task index

> The React dashboard is implemented and locally validated. Live Firebase, S3 and deployment remain separate operator checks.

**Goal:** Build all approved dashboard pages against the completed and verified backend APIs.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md), [Execution rules](../README.md).

B18 passed before D01 began. D01 through D14 are complete against the locally verified backend contract.

Create one React + TypeScript + Vite web app under `dashboard/`. D01 must verify compatible package versions and lock dependencies in `package-lock.json`; these plans do not preselect versions. Use Tailwind CSS + shadcn/ui, React Router, TanStack Query and Firebase Web Authentication. Validate with Vitest/React Testing Library/MSW, Playwright and a Vite production build. Browser tests cover viewport widths 360/768/1440; no native dashboard target is planned. Any separately requested device tests retain the designated iPhone-only restriction in the shared scope. Real configured Google and S3 browser proof remains separate from synthetic fixtures.

| Task                                    | Deliverable                                                     | Depends on                                            | Status           |
| --------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- | ---------------- |
| [D01](D01-dashboard-foundation-auth.md) | Dashboard package, design foundations and Google admission      | B18                                                   | COMPLETE (local) |
| [D02](D02-administrator-access-page.md) | Administrator list, role changes and owner protection           | D01, B03                                              | COMPLETE (local) |
| [D03](D03-overview-page.md)             | Overview cards, charts and date filters                         | D01, B15                                              | COMPLETE (local) |
| [D04](D04-workers-list-detail.md)       | Workers list and machine detail                                 | D01, B05                                              | COMPLETE (local) |
| [D05](D05-worker-management-dialogs.md) | Worker registration, credentials, drain and recovery UI         | D04                                                   | COMPLETE (local) |
| [D06](D06-jobs-queue-operations.md)     | Jobs table, attempt timeline and cancel/retry flows             | D01, D04, B09                                         | COMPLETE (local) |
| [D07](D07-users-processing-controls.md) | User directory and processing suspension UI                     | D01, D06, B07                                         | COMPLETE (local) |
| [D08](D08-audio-preview-download.md)    | Private input/result playback and download                      | D06, B10                                              | COMPLETE (local) |
| [D09](D09-release-editor-apk-upload.md) | Release list, draft editor and APK upload verification          | D01, B12                                              | COMPLETE (local) |
| [D10](D10-update-policy-publication.md) | Update policy preview, publication and withdrawal               | D09, B13, B14                                         | COMPLETE (local) |
| [D11](D11-processing-settings-page.md)  | Processing limits and maintenance settings                      | D01, B06                                              | COMPLETE (local) |
| [D12](D12-health-alerts-page.md)        | System health, issue detail and alert acknowledgment            | D04, B16                                              | COMPLETE (local) |
| [D13](D13-activity-audit-csv.md)        | Owner activity log and filtered CSV export actions              | D03, D06, B02, B17                                    | COMPLETE (local) |
| [D14](D14-full-dashboard-validation.md) | Full dashboard integration, accessibility and completion review | D02, D03, D05, D06, D07, D08, D09, D10, D11, D12, D13 | COMPLETE (local) |

## Progress record

- [x] Read shared scope/contracts and applicable repository instructions before execution.
- [x] Record changed files, commands/results and remaining validation limits.
- [x] Complete D14 local integration and accessibility checks.
- [x] Keep hosting, deployment, production data changes, source commit and push outside this work.
