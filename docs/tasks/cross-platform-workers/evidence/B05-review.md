# B05 independent review

Date: 2026-09-13. Scope: B05 claim admission and its runtime, release, scheduling, availability, and owned-attempt integration.

**Verdict: changes requested.** Two important findings reproduced against the compiled implementation. No critical finding identified. Neither finding requires compatibility code, migrations, hardware work, or a public qualification endpoint.

## Findings

### P1 — Hold new claims after activation has been authorized

Location: `backend/src/worker/worker-readiness.service.ts:157–161` (update hold states), and the subsequent source/target match branch. Integration context: `backend/src/worker-releases/worker-rollouts.service.ts:862–884` checks idle ownership when acknowledging `activating`.

`activating` is not a hold state. If the last runtime report still says `ready`, the source/target compatibility check allows a fresh assignment after the backend has acknowledged activation. The control fence correctly orders the transactions, but the later claim accepts the committed activating state. A delayed claim request can therefore reserve real work while the launcher is authorized to replace the runtime. This violates the update-between-assignments requirement; local stop-claim behavior alone cannot reject an already delayed request.

Reproducer executed in an isolated temporary copy of `backend/test/worker-readiness.integration.mjs`, using its approved `artifact`, `worker-a`, queued short job and runtime fixture. Immediately before `const sessionId = randomUUID()`, insert:

```js
await db.model('WorkerUpdatePolicy').create({
  _id: 'worker-a', revision: 1, rolloutId: randomUUID(), target: artifact,
  minimumClaimBuild: 100, allowedFallbackReleaseIds: [], stage: 'activating',
});
await assert.rejects(
  one.claim(randomUUID(), identities[0], 2),
  'fresh claim after activation acknowledgement must be held',
);
```

Observed: exit 1, `Missing expected rejection: fresh claim after activation acknowledgement must be held`. The fresh claim succeeded. This is an explicit persisted-policy reproducer; it does not simulate a native updater or claim that a real activation occurred.

Fix: treat the authoritative activation stage as a fresh-claim hold, including qualified queue capacity, while retaining the existing owned-attempt path. Add a regression for this state and preferably the activation-before-delayed-claim transaction ordering. Do not indiscriminately hold download/preparation states that are allowed alongside normal work.

### P2 — Evaluate unowned job availability against that job's media requirements

Location: `backend/src/worker/worker-registry.service.ts:172–184`. User-visible call: `backend/src/jobs/jobs-query.service.ts:125`.

The unowned-job branch returns true for any currently qualified worker without comparing the job's effective duration or input bytes to that worker's approved ceilings. `FairQueueService` correctly excludes those same workers for oversized jobs. Consequently, after the only long-capable worker loses qualification, the queued long job still reports `workerAvailable: true` if a short-only worker remains. This defeats B05's truthful per-job mobile availability requirement.

Reproducer executed in another isolated temporary copy of the existing compiled integration. Immediately after `const long = await enqueue(601, 1)`, insert:

```js
assert.equal(
  await registry.available(long), false,
  '601-second job must not report available with only 600-second workers',
);
```

Observed: exit 1, `true !== false` (actual true, expected false). The unchanged integration separately proves this 601-second job remains queued while the 10-second job is assigned.

Fix: include the job's scheduling duration (measured duration when present, otherwise reservation duration) and prepared-input byte requirements in the unowned availability check. Preserve qualified busy capacity and existing owned-job heartbeat/ownership visibility. Add duration and byte boundary regressions without returning worker IDs to mobile clients.

## Verified behavior and review coverage

- Claims write WorkerControl, WorkerRuntime.rolloutFence and ReleasePolicy `policy` in the same transaction. Inspected the controlled runtime-disqualification, withdrawal, floor, and revocation races and reran their compiled integration successfully.
- Signed approved-profile descriptors remain separate from contributor reports and publication state. Reviewed exact provider, fixture, model, dependency-lock, OS/architecture, installation, service binding, reboot, expiration and media-duration checks. Null approval fails closed, and a signed duration ceiling cannot exceed its fixture duration.
- Readiness stores references to immutable observations; B02 owns installation authentication, expiry, and report quotas. No public qualification route was expected or found as part of B05.
- Reviewed selected target compatibility and build floors, owned replay/heartbeat/stage/replacement recovery/completion/cleanup, and inherited admission evidence. The compiled owned-lifecycle scenario passes after a floor rise.
- Reviewed removal of frozen worker-ID scheduling checks, preserved queue ranking/user-running exclusion and busy-capacity distinction. Existing fairness integration passes; the availability finding above is a separate gap.

## Commands run independently

From `backend/`:

- `npm test -- src/worker/worker-readiness.service.spec.ts src/worker/worker-runtime.service.spec.ts src/worker-releases/worker-rollouts.service.spec.ts src/worker/worker.controller.spec.ts src/processing-queue/fair-queue.service.spec.ts` — 5 files, 52 tests passed.
- `npm run build` — passed.
- `node --test test/worker-readiness.integration.mjs` — passed, 1 test.
- `node --test test/worker-rollouts.integration.mjs` — passed, 1 test.
- `node --test test/fair-queue.integration.mjs` — passed, 1 test.
- `node --test test/worker-runtime.integration.mjs` — passed, 1 test.
- Two temporary isolated compiled-integration variants described above — each failed its new expected assertion, proving the findings. Temporary copies were removed; existing tests and implementation were not edited.

The seven documented broad processing-suite legacy fixture failures were not rerun and are not new findings or a reason to add bypasses. Their fleet-only fixture conversion remains B06 work. This review does not claim full-suite green, live deployment, native GPU qualification, service/reboot execution, artifact distribution, or installer/update hardware proof. Actual F01 candidates remain unavailable. Only this review document was changed; unrelated Android work was not modified.

## Round 1 re-review — 2026-09-14

**Verdict: approved for scoped local B05 implementation. Both findings are resolved; no additional important regression found in the fixes.** This supersedes the initial changes-requested verdict above while preserving its reproducer record.

- **P1 resolved:** persisted `activating` now produces `UPDATE_POLICY_HOLD` for both new claims and qualified capacity. Inspected and reran the real `WorkerRolloutsService.updateStatus` activation-before-delayed-claim regression: activation commits on the first connection, the delayed claim on the second connection retries and rejects without reserving an assignment. The five earlier preparation states remain eligible in focused tests. The coordinator's owned replay branch still precedes new-claim evaluation; existing owned heartbeat/replacement recovery/completion/cleanup coverage remains passing.
- **P2 resolved:** unowned availability now compares the same effective duration (`measuredDurationSeconds ?? inputReservation.durationSeconds`) and reservation bytes as the scheduler against the worker's approved ceilings. Inspected and reran exact-ceiling, one-second/one-byte excess, and measured-duration override assertions in both directions. Qualified busy capacity still reports availability for eligible media, and owned-job heartbeat visibility remains unchanged and passing.

Independent commands rerun from `backend/`:

- `npm test -- src/worker/worker-readiness.service.spec.ts src/worker/worker-runtime.service.spec.ts src/worker-releases/worker-rollouts.service.spec.ts src/worker/worker.controller.spec.ts src/processing-queue/fair-queue.service.spec.ts` — 5 files, 59 tests passed.
- `npm run build` — passed.
- `node --test test/worker-readiness.integration.mjs` — passed, 1 compiled integration test including the new activation ordering and availability boundary assertions.

Re-review was restricted to the two fixes, their coverage, and directly affected owned-work/preparation/capacity behavior. No implementation changes were made. The previously documented B02 authentication/quotas, B06 broad fixture conversion, F01 actual hardware availability, and native/distribution/deployment proof boundaries still apply. Approval is not a claim of full processing-suite green or production readiness.
