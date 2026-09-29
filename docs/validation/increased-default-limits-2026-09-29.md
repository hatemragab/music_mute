# Increased standard account limits — 2026-09-29

## Scope and saved production policy

User approved the proposed increase. Global standard policy was saved through the
existing authenticated, fresh-authenticated, revision-checked, audited dashboard
form, then independently reloaded as revision **1**. No usage reset or account
override write was performed.

| Field | New default |
| --- | ---: |
| Successful processing / UTC month | 36,000 seconds (600 minutes) |
| Audio duration | 1,800 seconds |
| Prepared audio | 100,000,000 bytes |
| Upload grants / UTC day | 100 |
| Upload grants / UTC month | 1,000 |
| Confirmed uploads / UTC month | 5,000,000,000 bytes |
| Retained storage | 5,000,000,000 bytes |
| Download grants / UTC month | 1,000 |
| Estimated downloads / UTC month | 50,000,000,000 bytes |
| Service outbound / UTC month | 500,000,000,000 bytes |

Preserved: 20 waiting jobs, one processing job/account, three infrastructure
attempts, five client/input attempts, 600-second signed URLs, 360-hour deletion
grace. Existing overrides continue replacing their selected fields.

## Implementation

- Backend account-policy defaults, shared absolute media ceilings, DTOs, Mongo
  validation, measured import validation, acquisition bounds, metadata bounds and
  worker result validation accept 1,800 seconds / 100 MB.
- Public policy keeps schema 2 and adds optional scalar `media_limits_version`.
  Version 2 opts into expanded media; omitted/version 1 clamps to 1,200 seconds /
  50 MB because installed Android/iOS clients reject larger public policy limits.
  Web opts in. URL imports use effective account policy.
- Comparison timelines now allow 79,380,000 samples at 44.1 kHz and 3,001 retained
  intervals, covering 30-minute audio with 0.6-second minimum silence cuts.
- Adapter validates the expanded request bounds and preserves streamed byte caps
  and scratch cleanup. Dashboard help text reflects the increased defaults.
- Main files: `backend/src/admin-settings/account-policy.schema.ts`,
  `account-policy.service.ts`, `backend/src/jobs/media-limits.ts`,
  `video_providers/videoscale/service.py`, `web-client/src/api/jobs.ts`,
  `dashboard/src/features/settings/processing-settings-form.tsx`,
  `worker/src/runtime/contracts.ts`. API contracts and boundary tests updated.

The current [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were reviewed: additive compatibility (106), API contract documentation (101),
and defined success/error responses (151). Existing admission snapshots retain
captured account limits.

## Checks actually run

- Backend `pnpm run verify`: formatting, lint, TypeScript, secret checks,
  transfer benchmark tests, **967 unit tests**, **151 HTTP tests**, build passed.
- `pnpm run test:imports:integration`: **15 passed**.
- `pnpm run test:processing:integration`: **15 passed**.
- Adapter `python3 -m unittest -v test_service.py test_official_metadata.py`:
  **50 passed**, including inclusive expanded caps and over-limit rejection.
- Web `npm run format:check`, `lint`, `typecheck`, `test`, `build`,
  `test:server`, `test:e2e`: **127 unit, 9 server, 6 browser tests passed**.
- Dashboard format, lint, typecheck, unit, deployment/build checks:
  **86 unit and 11 deployment tests passed**.
- Worker verify reached **420 passing tests, 2 conditional skips** plus passing
  protocol, formatting, lint, typecheck and packaging checks. Default engine
  interpreter lacked dependencies; reran with the installed qualified Python:
  **74 engine tests, one conditional skip**, successful suite and build.
  After the final interval-count edit, focused parser tests (**9**) and build passed.
- `git diff --check` passed. Existing unrelated changes preserved. No commit/push.

## Deployment proof

Source archives were allowlisted and byte-compared with source before deployment.
No dotenv, credentials, dependencies or unrelated source directories were included.

| App | Active CapRover image | Archive SHA-256 |
| --- | --- | --- |
| API | `img-captain-api:89` | `477fa41fbeb94cad12a8a65068c952a612960980075d8bcaf0f027c1f8d9dbbc` |
| Dashboard | `img-captain-dashboard:16` | `33b4678118c72b05b89e19923d53d67b82c017556dcd6874758fb18a6e32a269` |
| Web app | `img-captain-app:15` | `65e045b63dd085659e0404fe559eca2466b41f6db4319e2d071cc83899266096` |
| Private adapter | `img-captain-music-mute-videoscale:7` | `b8cef9a3c3f36b9441cd659fc4b6ecdfbbb53afa40a4ee9b8c5045c60fd761a7` |

Live API liveness/readiness and both browser app health endpoints passed.
Unauthenticated user/admin realtime-ticket requests and WebSocket upgrade returned
401. Public policy revision 1 returned 1,200 seconds/50 MB without the capability
and 1,800 seconds/100 MB with it. A brief 502 occurred during API replacement;
post-deployment probes passed.

Dashboard read-back confirmed all 16 numeric settings exactly. Account usage
showed 600 minutes, 100/1,000 upload grants, 5-GB uploads/storage, 1,000 download
grants and 50-GB downloads. Retained usage remained 695.71 MB and the usage
revision was unchanged: the allowance increased without deleting stored results.

## Local worker rollout and remaining limits

Local immutable release `0.1.0-mvp.45-limits.local.20260929.2` preserves the installed
engine, models, dependencies, credentials and all other runtime files. Inventory
comparison to the original socket release changed only the compiled result parser
and package version. Prior releases and private configuration/capacity backups
were retained. Graceful drains reported zero active attempts; no forced stop.

Both recipes and two-worker GPU qualification passed with 1.64x measured throughput
speedup. The release-bound manifest digest is
`74a05fbcc5c2bdf402126b084b1da5f3161d2942e539e2a65deabc7bcf8217bc`.
Final `mw start --wait-ready --json` reported ready, modelReady/localReady/claimEligible
true, with no blockers. `mw doctor --full --json` passed all 13 checks.
This is local activation, not a signed public fleet/catalog release. The dashboard
listed one enrolled machine; its catalog/enrollment version is historical.

Installed native apps retain their local upload and original-comparison timeline
limits until an app update is distributed. Larger account allowances apply to them
immediately. No native app release or device UI test was performed. No real
30-minute production import/job was submitted; contract, fixture, worker
qualification and live health evidence do not establish that end-to-end test.
