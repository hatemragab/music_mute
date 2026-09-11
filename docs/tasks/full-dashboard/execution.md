# Full dashboard implementation progress

Plan: docs/tasks/full-dashboard/README.md. Product target: complete the backend, then a React + TypeScript + Vite web dashboard with strong UI/UX and established open-source packages. B01–B18 and D01–D14 are implemented and validated locally; external provider, device and deployment proof remains separate.

## Current execution rulings

- The user selected React + TypeScript + Vite for the dashboard. The earlier framework translation was an assistant interpretation error. All D01–D14 paths, libraries and validation commands now target a web SPA with Tailwind CSS + shadcn/ui, React Router, TanStack Query and Firebase Web Authentication. Backend contracts and approved page/action acceptance remain authoritative.
- Work directly in the current `codex/backend-auth-users-devices` checkout, as instructed. It contains extensive unrelated and untracked work; do not reset/stash/delete/commit it or create a detached baseline that omits that source.
- Hosting remains excluded. No live owner bootstrap, cloud changes, deployment, push or commit is implied. The owner account is configured privately through the explicit bootstrap path when execution context permits; never hardcode its email in source or public fixtures.
- Use test-first implementation and review checkpoints. The user has resumed frontend implementation and the complete B18 local backend gate passes.
- Existing Windows-worker and mobile plans remain separately owned. Preserve protocol/lifecycle compatibility, document their integration boundaries, and do not silently implement a different app than the requested dashboard.

## Preflight

| Task group | Shared interfaces / conflict check                    | Resolution                                                                                                         |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| B01–B03    | AuthGuard, admin access, audit and owner mutations    | One admin registry and explicit protected metadata. B01 first; audit then access writes.                           |
| B04–B05    | Worker registry/control, ownership and administration | Shared controlRevision fences; no duplicate worker framework.                                                      |
| B06–B10    | Job admission, revision, deletion and user suspension | Reuse shared state machine/account fences; preserve existing accepted work and private object identities.          |
| B11–B14    | Release model, upload, publication and legacy policy  | One policy authority; draft never publishes; client compatibility is part of API gate.                             |
| B15–B18    | Read models, observability, CSV and contracts         | No invented metrics; backend gate requires real local integration plus honest provider boundaries.                 |
| D01–D14    | React + TypeScript + Vite web dashboard               | Implemented after the B18 gate with the approved permissions, actions, responsive browser UI and local validation. |

## Task state

- B01: Implemented; review fixes validated.
- B02: Implemented and independently reviewed. Persisted pending/failed/succeeded receipts fence mutations and audit in one transaction; no ephemeral secrets persist.
- B03–B04: Implemented — owner access/bootstrap and per-machine identity/ownership, with local validation and review.
- B05: Implemented — worker controls; independent transaction races validated.
- B06–B07: Implemented — admission settings and processing suspension; legacy revision and search review fixes validated.
- B08: Implemented — paged job/attempt views; privacy and recovery timing review fixes validated.
- B09: Implemented — shared administrative cancellation and retry, including native lifecycle/admission/audit races.
- B10: Implemented and independently reviewed — private audited media grants.
- B11–B13: Implemented — release models, pinned APK verification and atomic publication/withdrawal; local validation completed.
- B14: Implemented — outdated-client admission preserves accepted work while blocking new outdated submissions.
- B15–B16: Implemented — bounded overview metrics and persistent health/alert episodes.
- B17: Implemented — bounded, audited and spreadsheet-safe CSV exports.
- B18: Implemented and validated locally — 44-route authorization matrix, connected synthetic workflow, compiled startup, curl route probes and broad regressions pass.
- D01–D14: Implemented and validated locally — all 14 routes, five-role permission behavior, complete mocked workflows, accessibility/responsive checks and an isolated compiled-backend browser contract pass.

## Evidence

- Initial feature branch and dirty checkout inspected. No baseline source was reset or removed.
- Existing unit baseline: 432 tests passed before administration changes.
- B01 focused unit validation: 84 tests passed; admin/auth/worker HTTP validation: 26 tests passed; typecheck/build/scoped lint and formatting passed.
- B02 typecheck, lint, build and `node --test test/admin-audit.integration.mjs` passed. Isolated replica-set proof covers pending lookup, duplicate request rejection, secret-free replay, audit rollback, expired reservation, and revoked authority. Independent review also proved expiry cannot override an active committing transaction.
- Infrastructure isolated MongoDB/Redis outage-recovery integration passed after administration module registration.
- Latest serialized backend build passed. Native B08/B10/B13 plus expanded B05 controls passed 15 tests, including both commit orders for drain/claim, recovery/finish, revoke/output and rotation/pending-poll. Separate B07/B14 native checks passed 2 tests.
- B10 focused media/storage tests passed 24 tests; HTTP permission/reauthentication/validation/no-store check passed. Native transactions prove audit rollback, deletion denial, receipt redaction and replay without issuing another URL. Real S3 Range and browser codec testing remain external integration prerequisites.
- Mongoose connection-level `sanitizeFilter` is ignored by this installed version's query path; dedicated validation now explicitly activates the effective setting and uses trusted server-built comparison operators. Production-wide configuration was not changed.
- The 2026-09-11 backend gate passed `npm run verify`: formatting, lint and typecheck; 653 unit tests in 86 files; 134 HTTP tests in 25 files; and a Nest build.
- `npm run test:dashboard:integration` passed 55 native tests. It includes real local Android APK-tool verification, MongoDB transaction races, the 45-route/five-role matrix, and a compiled connected workflow.
- `npm run test:auth:integration`, `npm run test:processing:integration` and `npm run test:deletion:integration` passed 17, 21 and 2 tests respectively.
- `npm run test:dashboard:curl` probed all 45 admin routes through `/usr/bin/curl`, made 36 connected workflow requests, persisted 13 audit events and wrote 43 synthetic documents across 26 collections in an owned database on local MongoDB replica set `rs0`. MongoDB MCP read-back confirmed the data; the owned fixture database was then removed.
- Dashboard `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass. Vitest covers 14 tests across 5 files; the production build uses route-level lazy loading and emits no oversized-chunk warning.
- Dashboard `npm run test:e2e` passes 22 Chrome tests: 3 authentication, 6 permission, 9 full-workflow, 3 accessibility/responsive and 1 isolated compiled-backend contract test. The contract test proves owner admission, forged support denial, duplicate operation fencing/read-back, stale revision rejection and immediate support revocation.
- Browser fixtures cover all 14 routes, exact-filter CSV, administrator access, worker registration/key handling/recovery, suspension, private media expiry/renewal, job cancellation/retry, APK hashing/upload/verification, policy preview/publication, settings conflict and ambiguous-response receipt read-back.
- These are local implementation, local Android-tool and isolated/fake-provider results. Live Firebase, S3/IAM/CORS, maintained APK signer compatibility, a physical Windows worker, mobile installation and production deployment are not implied.
