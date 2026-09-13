# Backend B01–B06 implementation evidence

Local source frozen 2026-09-13 after final validation. No commit, push, deployment,
environment edit, secret change, or production/worker mutation performed by this
owner. Parent owns deployment and backend/separate.py.

## Outcome

Implemented additive policy v2 inclusive 1800s/100MB with evidence-backed activation,
immutable accepted budgets, one unfinished account job, shared rolling audio usage,
transactional global capacity, fair/aging Mongo selection, measured duration checks
before processing, execution evidence and safe cancellation settlement, worker
compatibility negotiation, account exceptions/expiry, and revision-protected admin
policy/audit/queue endpoints. Defaults retain safe legacy intake and leave expanded
jobs disabled with qualification absent. Full configuration can activate expansion
without another code change after genuine measured qualification.

Late recovery evidence now settles terminal pending usage in its evidence transaction;
identical replay remains successful. separationCompleted debits full measured media;
partial stopped execution uses accepted measured ratio. Unknown terminal holds
replenish after a conservative 24h bound; unfinished holds never auto-expire.
Long-job pause starts strictly above 600s; qualified exact-600s remains admitted.

## Validation

- TDD: initial pure policy/accounting/cost/evidence tests observed failing before
  implementation. Exact-600 boundary regression observed MEDIA_TOO_LONG before fix.
  Pending-expiry regression observed remaining3000 vs expected3600 before fix.
- Final `npm run verify`: PASS; formatter, zero-warning oxlint, TypeScript,
  tracked secret scan, 807 unit tests/110 files, 148 HTTP e2e tests/25 files, build.
  One prior full run had an isolated admin-users socket-hang-up; unchanged rerun
  passed. No source workaround applied for that transport flake.
- Final `npm run test:processing:integration`: PASS, 21 tests on isolated services.
- Final `node --test --test-concurrency=1 test/processing-policy-admin.integration.mjs
  test/processing-usage.integration.mjs test/admin-admission.integration.mjs
  test/fair-queue.integration.mjs test/worker-recovery.integration.mjs`: PASS, 5.
- Earlier targeted admin-users/admin-jobs-read/dashboard-contract/infrastructure
  integrations passed. Infrastructure test exercises external Redis outage/recovery.
- `git diff --check -- backend`: PASS.
- Logs: /tmp/media-backend-verify.log,
  /tmp/media-backend-final-integration.log,
  /tmp/media-test-processing-integration.log.

Focused integration proves same-account and cross-account races, no duplicate
reservations, grant denial when unavailable/full, inclusive maxima, legacy worker
fencing, measured cancellation debit, completed-separation debit, terminal pending
expiry, late evidence immediate settlement and replay, admin real audit/CAS/replay,
allowance expiry, suspension eligibility, actual-usage fairness and aging.

## Decisions and remaining operational limits

- Durable outstanding Job records plus transaction fence replace redundant capacity
  counters; ledger job IDs remain unique. Shared cost model is positive linear;
  duration ordering is equivalent under a common model.
- Existing per-account Redis attempt limits remain in force. No benchmark values
  were invented. Synthetic qualification appears only in isolated test fixtures.
- Actual Windows qualification/benchmarks, measured native source limits, installed
  qualified worker proof, and live deployment read-back remain parent/operator work.
- Queue wait estimates and untracked rejection history are explicitly null. Fixed
  short/long dashboard distribution uses600s; scheduler uses continuous cost/aging.
- Safe allowlisted processingChanges before/after values are audited. Broad legacy
  settings audit storage format remains backward compatible.
- New collections/indexes are additive; no destructive migration/backfill. Active
  usage does not rely on TTL. Removed account records are purged only after existing
  account deletion completion fences; visible job deletion does not refund usage.

## Exact changed backend files

- `backend/docs/api/audio-processing.md`
- `backend/docs/api/media-policy-v2.md`
- `backend/src/admin-jobs/admin-jobs-query.service.ts`
- `backend/src/admin-jobs/admin-jobs.controller.ts`
- `backend/src/admin-jobs/admin-jobs.presenter.ts`
- `backend/src/admin-settings/admin-settings.controller.ts`
- `backend/src/admin-settings/admin-settings.module.ts`
- `backend/src/admin-settings/dto/processing-qualification.dto.ts`
- `backend/src/admin-settings/dto/queue-policy.dto.ts`
- `backend/src/admin-settings/processing-admission.service.spec.ts`
- `backend/src/admin-settings/processing-admission.service.ts`
- `backend/src/admin-settings/processing-policy-v2.spec.ts`
- `backend/src/admin-settings/processing-policy-v2.ts`
- `backend/src/admin-settings/processing-qualification.spec.ts`
- `backend/src/admin-settings/processing-qualification.ts`
- `backend/src/admin-settings/processing-settings.service.ts`
- `backend/src/admin-settings/queue-policy.schema.ts`
- `backend/src/admin-settings/queue-policy.service.ts`
- `backend/src/admin-settings/queue-policy.spec.ts`
- `backend/src/admin-users/admin-users.controller.ts`
- `backend/src/admin-users/admin-users.presenter.ts`
- `backend/src/admin-users/admin-users.service.ts`
- `backend/src/admin-users/dto/admin-user.dto.ts`
- `backend/src/admin-workers/admin-workers.presenter.ts`
- `backend/src/admin/admin-audit-query.ts`
- `backend/src/admin/admin-audit.schema.ts`
- `backend/src/admin/admin-audit.service.ts`
- `backend/src/admin/admin-operations.service.ts`
- `backend/src/jobs/dto/create-job.dto.ts`
- `backend/src/jobs/job-actions.service.ts`
- `backend/src/jobs/job-attempt.schema.ts`
- `backend/src/jobs/job-errors.ts`
- `backend/src/jobs/job-metadata.spec.ts`
- `backend/src/jobs/job-metadata.ts`
- `backend/src/jobs/job-state.ts`
- `backend/src/jobs/job.schema.ts`
- `backend/src/jobs/job.types.ts`
- `backend/src/jobs/jobs.controller.ts`
- `backend/src/jobs/jobs.service.ts`
- `backend/src/processing-queue/fair-queue.service.spec.ts`
- `backend/src/processing-queue/fair-queue.service.ts`
- `backend/src/processing-queue/queue-capacity.service.ts`
- `backend/src/processing-queue/queue-cost.spec.ts`
- `backend/src/processing-queue/queue-cost.ts`
- `backend/src/processing-queue/queue-scheduling.schema.ts`
- `backend/src/processing-usage/processing-allowance.spec.ts`
- `backend/src/processing-usage/processing-allowance.ts`
- `backend/src/processing-usage/processing-usage.controller.ts`
- `backend/src/processing-usage/processing-usage.schema.ts`
- `backend/src/processing-usage/processing-usage.service.ts`
- `backend/src/processing-usage/usage-accounting.spec.ts`
- `backend/src/processing-usage/usage-accounting.ts`
- `backend/src/processing/processing-persistence.module.ts`
- `backend/src/processing/processing-storage-cleanup.service.spec.ts`
- `backend/src/processing/processing-storage-cleanup.service.ts`
- `backend/src/processing/processing.module.ts`
- `backend/src/storage/storage-transfers.service.ts`
- `backend/src/users/account-deletion-cleanup.service.ts`
- `backend/src/users/user.schema.ts`
- `backend/src/worker/dto/execution-evidence.dto.ts`
- `backend/src/worker/dto/reconcile.dto.ts`
- `backend/src/worker/dto/worker-event.dto.spec.ts`
- `backend/src/worker/dto/worker-event.dto.ts`
- `backend/src/worker/dto/worker-output.dto.spec.ts`
- `backend/src/worker/dto/worker-output.dto.ts`
- `backend/src/worker/dto/worker-request.dto.ts`
- `backend/src/worker/execution-evidence.spec.ts`
- `backend/src/worker/execution-evidence.ts`
- `backend/src/worker/worker-claim-wait.service.ts`
- `backend/src/worker/worker-control.schema.ts`
- `backend/src/worker/worker-coordinator.service.ts`
- `backend/src/worker/worker-identity.service.ts`
- `backend/src/worker/worker-output.service.ts`
- `backend/src/worker/worker-recovery.service.ts`
- `backend/src/worker/worker-terminal.service.ts`
- `backend/src/worker/worker.controller.ts`
- `backend/test/admin-admission.integration.mjs`
- `backend/test/admin-jobs-read.integration.mjs`
- `backend/test/admin-settings.e2e-spec.ts`
- `backend/test/audio-processing.integration.mjs`
- `backend/test/fair-queue.integration.mjs`
- `backend/test/fixtures/dashboard-contracts/routes.json`
- `backend/test/job-actions.integration.mjs`
- `backend/test/processing-persistence.integration.mjs`
- `backend/test/processing-policy-admin.integration.mjs`
- `backend/test/processing-usage.integration.mjs`
- `backend/test/worker-claim-wait.integration.mjs`
- `backend/test/worker-coordinator.integration.mjs`
- `backend/test/worker-recovery.integration.mjs`

## Post-deployment stable worker management CAS repair

Production investigation found idle claim/heartbeat authority fencing advanced the
same revision used by admin drain, making routine UI confirmation stale repeatedly.
The additive managementRevision defaults to zero for old records and advances only
successful admin mutations. Existing revision/expectedRevision HTTP names remain
unchanged. Internal controlRevision fencing is preserved; stopped recovery still
validates its current internal revision plus exact assignment and stop evidence.

Changed for this repair: backend/src/worker/worker-control.schema.ts,
backend/src/admin-workers/admin-workers.presenter.ts,
backend/src/admin-workers/admin-workers.service.ts,
backend/src/admin-workers/admin-workers.service.spec.ts,
backend/test/admin-workers.integration.mjs, and backend/docs/api/media-policy-v2.md.
No dashboard change, migration, worker operation or deployment by this owner.
Regression observed REVISION_CONFLICT before implementation. Focused real Mongo
admin/worker suite passes13 tests including missing-field legacy controls, idle
claim/heartbeat tolerance, competing admin CAS and recovery/revoke/key-rotation
races. Full npm run verify passes807 unit and148 e2e plus lint/typecheck/build.
Logs: /tmp/worker-management-red.log, /tmp/worker-management-integration.log,
/tmp/worker-management-verify.log.
