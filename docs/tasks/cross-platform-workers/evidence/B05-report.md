# B05 execution report

Date: 2026-09-13 (local implementation; isolated verification completed during the Cairo evening).

Status: local B05 implementation ready for independent review. No native profile is qualified by this work. The complete processing integration command is not green: seven pre-fleet fixture failures are explicitly listed below for B06; no compatibility bypass was introduced.

## Implemented behavior

- Fresh claims require an enabled installation-bound identity, a runtime received within five minutes, protocol 3, ready activity, exact published build/OS/architecture/model/dependency-lock identity, a nonexpired signed approved profile, matching persisted installation fixture/provider/GPU/service execution report, exact service binding and unattended reboot report, current selected update policy, and no reserved assignment.
- Publication receipts now require `approvedProfile`, explicitly nullable. Null remains unqualified. Signed descriptors bind evidence bundle digest, fixture digest and duration, provider, service binding, expiry, duration/byte ceilings and wall-time bound. The duration ceiling cannot exceed the exact tested fixture duration. Consequently a short installer fixture cannot establish a long-media ceiling. Actual F01 candidates remain unavailable.
- Fresh claims use the existing WorkerControl transaction and additionally write WorkerRuntime.rolloutFence and the existing ReleasePolicy row `_id: policy`. Runtime reports already update the same runtime row, so eligibility-changing reports conflict with claims; periodic observations also serialize on that row but do not change managementRevision. Installation readiness and selected target changes use WorkerControl; publication/withdrawal use ReleasePolicy. No nested update-policy transaction is used.
- Before an update runs, the current recipe may match the target recipe or a signed compatible source. After running/verified it must match the exact target build. The selected minimum build and held/quarantined/withdrawn target state block new work.
- An existing owned attempt can replay, heartbeat, stage, finish, acknowledge local cleanup, and reconcile after a build-floor rise. Replacement recovery attempts inherit the original immutable claim media evidence. The worker cannot claim an unrelated job on the prohibited build.
- Fair queue ranking, owner-running exclusion, aging and actual usage sorting remain intact. Live approved media limits replace the frozen worker-ID eligibility list for scheduling; original submission snapshots remain unchanged for audit. Each assigned attempt records the report/evidence/media ceilings, and measured stage duration cannot exceed those ceilings.
- Qualified busy workers still contribute bounded queue capacity; immediate claim-slot availability is separate. Unowned-job availability uses current qualification; owned-job availability retains existing heartbeat/ownership visibility. No worker IDs are added to mobile responses. HTTP 204 idle claims include `X-Worker-Reason: IDLE_NO_JOB`; HTTP 409 admission refusals include specific reasonCodes.

## Files

New:

- `backend/src/worker/worker-readiness.service.ts`
- `backend/src/worker/worker-readiness.service.spec.ts`
- `backend/src/worker/worker-qualification.schema.ts`
- `backend/src/worker/worker-qualification.service.ts`
- `backend/test/worker-readiness.integration.mjs`

B05 modifications:

- Worker runtime, coordinator, registry, recovery and controller; job-attempt schema.
- FairQueueService, queue-policy qualified capacity, processing admission, processing model/service composition.
- B04 publication-receipt descriptor/verification and signed-receipt fixture tests, compiled rollout fixture metadata.
- B01 compiled runtime test expectation updated from its placeholder approval-required code to the implemented GPU qualification-required code.
- Shared contracts specify the approval source and B02 service interface.

QueueCapacityService's existing bounded backlog accounting remains in use unchanged; live capacity qualification is supplied through the existing queue-policy/processing-admission call path. WorkerClaimWaitService naturally propagates specific denial responses from coordinator and only waits on genuine null/no-job results; no polling bypass was added.

## B02 exported interface and prerequisites

`WorkerQualificationService.store(installationId: string, runtime: WorkerRuntimeDto, report: QualificationReportDto, serviceBindingSha256: string)` validates bounded DTOs/exact binding and stores an immutable contributor observation. Returns `{ reportId, decision: 'reported', reasonCodes: ['INSTALLATION_READINESS_REQUIRED'] }`.

`evaluateForPairing(installationId: string, reportId: string, session?: ClientSession)` returns `{ reportId, allowed, reasonCodes }`. It requires matching approved published recipe and service-context/model/provider/fixture execution; it does not require reboot. Pass the existing pairing-approval session to fence ReleasePolicy and avoid publication withdrawal races. It reads only the requested installation's report.

Both services are exported by AudioProcessingModule. B02 must authenticate its installation bearer, enforce expiry/report rate and count limits, and bind the report to its session before calling these methods. B05 exposes no unauthenticated or public qualification controller. Unsupported GPU registration/failure reporting remains a B02/B03 capability, independent of pairing qualification. Permanent-auth `installationReady` then binds runtime/report/boot and returns canClaim from full current admission evaluation.

## Exact H01/H02 authority contract

H01 must create an explicit approved descriptor from the reviewed F01/native hardware evidence record and exact fixture manifest, never from successful packaging or an accelerator flag. `evidenceSha256` identifies that reviewed bundle; fixture digest/duration, service-definition/principal binding digest, provider and media/time ceilings must come from it. Artifact OS/architecture/build/model/lock identities are included in the same signed receipt. H02 must verify this descriptor and artifact against the signed TUF target before issuing its configured Ed25519 publication receipt. Contributor observations remain distinct from this offline authority. This repository contains synthetic isolated descriptors for testing only; no actual GPU, driver, native service, reboot, artifact-hosting or distribution proof was produced.

## Red/green evidence

The admission test initially loaded a minimal permissive evaluator and failed its intended assertions: 19 failed cases covering absent/stale runtime, publication without approval, expired approval, withdrawn release, CPU-only/wrong-provider/wrong-model/wrong-lock/wrong-fixture reports, installation ownership, boot binding, recovery/drain/reservation, selected floor and pause. Implementing the evaluator made those cases green. A subsequent pre-update unchanged-recipe test failed (false instead of true) and then passed after restoring B04's source-versus-running semantics. Added tests cover short-fixture ceilings, pairing before reboot, and descriptor signature tampering plus a validly signed inconsistent media descriptor.

## Validation actually run

From `backend/`:

- Focused Vitest command for readiness, runtime, publication/rollouts, fair queue and worker controller: **5 files, 52 tests passed**.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed (repeated builds emitted compiled API/services).
- Scoped Prettier: all B05 files checked; one qualification-service formatting warning was fixed and its check passed.
- `git diff --check`: passed.
- `node --test test/worker-readiness.integration.mjs`: passed, including final owned replacement-recovery case. Uses isolated local replica-set MongoDB and Redis with compiled application services and two independent Mongo connections/coordinator instances.
- `node --test test/worker-rollouts.integration.mjs`: passed after the receipt fixture explicitly supplied `approvedProfile: null`.
- `node --test test/fair-queue.integration.mjs`: passed actual usage/duration/aging/eligibility regression.
- `node --test test/worker-runtime.integration.mjs`: passed after replacing B01's placeholder expected denial code; installation ownership and lifecycle revision behavior remain verified.
- `npm run test:processing:integration`: **21 tests, 14 passed, 7 failed**. One broad run only; captured at `/tmp/b05-processing-validation.log` for local inspection.

The controlled B05 integration proves: a 601-second job is skipped for a 600-second fixture-qualified worker; a version-2 job previously admitted with only a retired worker ID can be assigned to a newly qualified worker; two API instances produce one assignment; measured 601 seconds is refused; floor-rise replay/heartbeat and owned replacement recovery/completion/cleanup/terminal reconcile succeed; unrelated new work is refused; busy capacity remains available without managementRevision changes; runtime disqualification, release withdrawal, selected-floor mutation and revocation committed against suspended claim snapshots prevent invalid fresh assignment.

## Broad-suite limitations for B06

These tests still create or authenticate the old unregistered `z440`/legacy worker and now fail at the intended fleet readiness boundary, not at a new native GPU test:

- `backend/test/jobs-cancel.integration.mjs:6`
- `backend/test/worker-claim-intent.integration.mjs:6`
- `backend/test/worker-claim-wait.integration.mjs:14`
- `backend/test/worker-coordinator.integration.mjs:12`
- `backend/test/worker-output.integration.mjs:6`
- `backend/test/worker-races.integration.mjs:6`
- `backend/test/worker-recovery.integration.mjs:6`

The output fixture explicitly receives `WORKER_NOT_ENABLED` with missing runtime/release/profile/qualification/boot reason codes. Other failures assert successful old-style claims or wait results. B06 should convert those fixture identities and reports as part of its requested fleet-only cutover. No mode-based admission fallback, old-client decoder, migration or backfill was added to make them pass.

## Self-review and boundaries

Inspected the changed admission and qualification paths and removed both frozen-ID checks (queue selection and assignment). Kept recovery ownership selectors, user-running protection, queue snapshots and unrelated files intact. Checked the global release fence uses the existing `policy` identifier, not a new fence row. Retained short-fixture media restrictions in measured stages and replacement attempts. Publication-null remains fail-closed.

No commits, pushes, deployment, publication, native GPU execution, migrations, backfills, credential access, live service/data changes or Android edits were performed. Local tests use synthetic identities/evidence, isolated databases and stubbed storage outputs; passing them is not native qualification or production proof. Independent review remains required. Full fleet-only processing regression awaits B06 fixture conversion.

## Review round 1 fixes — 2026-09-14

Addressed both findings in `B05-review.md`; ready for scoped independent re-review.

### P1: authoritative activation hold

`backend/src/worker/worker-readiness.service.ts:159` now includes persisted `activating` in the fresh-claim and qualified-capacity hold states. Earlier available/downloading/prepared/waiting_for_idle/validating stages remain eligible; the existing owned replay/reconciliation path still runs before new-claim evaluation.

Added unit regressions at `backend/src/worker/worker-readiness.service.spec.ts:125` for both fresh claims and capacity during activation, plus all five permitted preparation stages. Added a compiled ordered race at `backend/test/worker-readiness.integration.mjs:252`: a claim from the second API connection pauses before its WorkerControl fence; real `WorkerRolloutsService.updateStatus` commits activating with idle ownership from the first connection; the delayed claim resumes, retries its stale transaction, observes activation, and returns UPDATE_POLICY_HOLD without reserving a job. This exercises the actual update-status transaction, not only direct policy fixture insertion. Native launcher replacement remains outside local proof.

### P2: media-specific unowned availability

`backend/src/worker/worker-registry.service.ts:157` now accepts the media fields needed by the unowned availability path. At line 184 it uses exactly the scheduler's `measuredDurationSeconds ?? inputReservation.durationSeconds` and compares reservation bytes against the same approved duration/byte ceilings. Qualified busy capacity remains supported. The owned-job heartbeat/registration lookup is unchanged.

Compiled boundary regressions start at `backend/test/worker-readiness.integration.mjs:212`: 600 seconds/1,000,000 bytes is available; 601 seconds or 1,000,001 bytes is unavailable; measured duration overrides reservation in both directions. The queued 601-second fixture now reports unavailable while the 600-second-only workers remain qualified. Additional busy-capacity and owned-job visibility assertions appear at line 506.

### Reproduced failures and final checks

Before production changes, the new activation unit cases failed (2 failed/28 passed: allowed true instead of false), and compiled integration failed because the 601-second job reported available. After the availability fix alone, all boundary assertions passed and the real activation-before-delayed-claim regression failed with `Missing expected rejection`. After adding the activating hold, both regressions passed.

Commands from backend, run for this fix round:

- Focused readiness/runtime/publication/controller/fair-queue Vitest: **5 files, 59 tests passed**.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `node --test test/worker-readiness.integration.mjs`: passed, including the new activation transaction and media boundaries and the existing owned recovery/completion/race cases.
- Scoped `npx prettier --check` for all four changed source/test files: passed after formatting.
- `git diff --check`: passed.

Only the two production services, their readiness unit/integration tests, and this report changed in this fix round. No broad legacy suite rerun; its prior seven B06 fixture failures remain as documented. No migrations, compatibility branches, commits, live changes, deployment, native GPU proof, or unrelated Android changes.
