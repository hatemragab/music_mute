# Dashboard D01–D03 implementation evidence

Local implementation and validation on 2026-09-13. No production policy was changed to demonstrate these controls. Parent owns API/dashboard deployment and authenticated production read-back.

## D01 — Policy editor

Existing Settings route now hosts a separate v2 editor using `GET/PUT /admin/settings/processing-v2`, preserving the existing legacy editor/document. Exact seconds and decimal bytes, one unfinished job, rolling allowance, outstanding count/audio budgets, aging and admission flags are reviewable. Qualification is explicit: evidence identity/revisions, measurement/expiry, qualified workers, source/download/preparation/output bounds, deadlines and cost model. No missing measurement is prefilled with invented capacity. Missing readiness disables enabling new long jobs; accepted snapshots and existing worker slots remain unchanged.

Reason, fresh authentication, UUID operation ID and frozen expected revision are mandatory. Saves use existing receipt reconciliation plus authoritative GET. Conflict preserves the draft and requires explicit refreshed review. Combined unsaved-change guard covers both editors. Existing qualification is retained on unrelated edits; explicit removal clears qualification and long admission. Identical expired evidence may be retained for unrelated policy changes without pretending it is fresh.

Main paths: `dashboard/src/features/settings/processing-policy-{editor,validation,summary}.*`, `settings-api.ts`, `processing-settings-page.tsx`, `dashboard/src/api/contracts.ts`.

## D02 — Workload and capabilities

Existing Jobs and Overview routes share queue workload: queued jobs/audio, all outstanding reservation count/audio, limits, oldest queue timestamp, checked time, stale estimate suppression, nullable estimated time/range and short/long distribution when provided. Separate labels explain running long jobs and unresolved cancellation. Existing filtering, pagination, cancellation, drain and recovery remain intact.

Job detail exposes source category, declared/measured duration and bytes, estimated worker time separately from stages and separator execution. Attempts show stop/completion evidence without assuming release. Worker detail shows reported media protocol and capability observation alongside existing safe slot/assignment state. Measured physical ceilings and untracked rejection history are explicitly unavailable. The reporting boundary is read-only; scheduler policy remains work-based plus aging.

Main paths: `dashboard/src/features/jobs/queue-summary-*`, `job-detail-page.tsx`, `job-attempt-timeline.tsx`, `workers/worker-detail-page.tsx`, `overview/overview-page.tsx`.

## D03 — Account usage and exceptions

User detail shows used/reserved/remaining audio, unfinished count, allowance, server availability, next and individual replenishments, override expiry, checked time and revisions. Temporary increases and explicit revocation use bounded amount/expiry, reason, fresh authentication, frozen revision, operation receipts and read-back. Revocation keeps accepted reservations. Optional suspension expiry uses the existing action; effective suspension comes from the backend presenter and does not switch from a browser timer. Existing activity history remains the audit surface and renders only backend-allowlisted processing before/after fields, including allowance and suspension expiry, with actor and reason.

Main paths: `dashboard/src/features/users/processing-{usage-panel,allowance-dialog,access-validation,suspension-dialog}.*`, `user-detail-page.tsx`, `users-api.ts`.

## Executed validation

- Test-first initial focused run failed for missing v2 modules; the initial five behavior tests then passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with zero warnings.
- `npm run format:check`: passed across dashboard.
- `npm test`: 55 tests in 18 files passed; includes inclusive bounds, missing/stale qualification, stale estimated work, usage/reservation separation and bounded suspension/allowance expiry, distribution and audit changes.
- Targeted v2 browser flows: 6 passed (policy exact units/read-back, read-only role, CAS preserved draft, queue 31 vs 32 audio minutes, allowance increase/revoke reservations, read-only allowance).
- `npm run test:e2e`: all 36 then-current tests passed, including existing backend contracts, all routes, permissions, cancellation/recovery, receipt uncertainty, responsive widths, keyboard focus, both themes and accessibility.
- Additional `e2e/processing-policy-contract.spec.ts`: 1 passed against the actual compiled isolated Nest backend; v2 GET/PUT/read-back, 409 stale revision, disabled unqualified expansion, null queue wait, allowance DTO acceptance followed by absent-user 404.
- Final seven v2 UI/compiled-contract browser checks passed after threshold/distribution integration. The compiled contract test was rerun once more with exact distribution/600-second assertions and passed.
- `npm run build`: production Vite/TypeScript build passed.
- `git diff --check -- dashboard`: passed.

Logs: `/tmp/musicmute-dashboard-{tests,lint,typecheck,format-check,build,full-e2e,contract-e2e}.log`. Fixture browser tests and isolated local backend are not production proof. No mobile/device targets are involved in dashboard browser tests.

## Evidence limits

No physical worker qualification, missing cost model, sensor reading, estimated wait or rejection ledger is fabricated. Qualification controls provide an activation path but do not establish physical worker readiness. Parent must perform deployment and production read-only smoke checks separately. Real expiring-account behavior and reservation enforcement are backend responsibilities; dashboard fixtures prove payload/UI behavior and compiled contract tests prove strict API compatibility, not production account changes.
