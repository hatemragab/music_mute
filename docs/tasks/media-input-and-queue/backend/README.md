# Backend implementation tasks

**Status: not started; plan approval required.** Read [scope](../scope.md) and [contracts](../contracts.md). Own only backend code/docs/tests. Keep NestJS API-only, MongoDB authoritative, existing external Redis and S3 boundaries, and strict TypeScript/ESM `.js` imports. No migrations or production operations.

## B01 — Policy version 2 and compatibility

**Depends on:** R01; R02 gates benchmark-dependent enablement. **Consumes/produces:** C1 `ProcessingPolicyV2`, versioned admission snapshots, C4 assignment limit schema, C6 safe problems.

**Modify:** `backend/src/admin-settings/{processing-settings.schema.ts,processing-settings.service.ts,admin-settings.controller.ts,dto/processing-settings.dto.ts}`, `backend/src/jobs/{job.types.ts,job-state.ts,job-errors.ts,job.schema.ts,job-request.ts,dto/create-job.dto.ts}`, `backend/src/config/environment.ts`, `backend/docs/api/audio-processing.md`, and existing processing policy/API tests. Preserve existing central key validation and extend `backend/src/config/processing-environment.spec.ts` for changed limits.

**Create:** `backend/src/admin-settings/processing-policy-v2.ts` and `.spec.ts` for pure normalization/compatibility rules. Keep proposed limit types in this module; use type-only imports from other modules.

- [ ] Write tests for v1 request/default response stability, v2 inclusive boundaries, unknown schema/profile rejection, corrupted stored policy, and old dashboard update rejection once new fields are active.
- [ ] Add `normalizeProcessingPolicyV2` and `assertPreparedAudioV2` with finite/safe-integer checks, inclusive 1800-second and 100,000,000-byte limits, and unavailable measurement gating. Example boundary test:

```ts
expect(() => assertPreparedAudioV2({ bytes: 100_000_000, durationSeconds: 1800 }, policy)).not.toThrow();
expect(() => assertPreparedAudioV2({ bytes: 100_000_001, durationSeconds: 1800 }, policy)).toThrow();
expect(() => assertPreparedAudioV2({ bytes: 1000, durationSeconds: 1800.001 }, policy)).toThrow();
```

Here `policy` is an explicit v2 test fixture with every C1 field populated; include NaN, Infinity, zero, negative, and fractional-byte inputs. Define these two named functions in the new module and use them instead of duplicating validators.

- [ ] Extend existing public policy with the explicit schema query; never expose private usage. Add v2 request metadata and immutable snapshot discriminator while preserving old accepted records and their exclusive physical ceilings. Do not merely search-and-replace `600`.
- [ ] Inventory input, output, S3 grant, client, worker, and DTO size limits. Introduce compatible versioned output limits; old jobs remain under their previous ceilings. Keep new capabilities disabled until required evidence and worker agreement exist.
- [ ] Document request/response/error examples and the exact old/new transition. Additive collections/indexes only through existing declared model initialization; do not rewrite old records.

**Validation (backend cwd):** `npm test -- src/admin-settings/processing-policy-v2.spec.ts src/admin-settings/processing-settings.service.spec.ts src/jobs/job-state.spec.ts src/jobs/dto/create-job.dto.spec.ts`; `npm run typecheck`.

**Acceptance:** strict v1 compatibility and inclusive v2 boundary proof; no capable worker/evidence means no expanded job admission, not a signed grant followed by inevitable failure.

## B02 — Atomic account allowance and unfinished-job limit

**Depends on:** B01. **Consumes/produces:** C2 `ProcessingUsage`, `UsageOutcome`, and ledger service methods.

**Create:** `backend/src/processing-usage/{processing-usage.schema.ts,processing-usage.service.ts,processing-usage.service.spec.ts,processing-usage.controller.ts,processing-usage.controller.spec.ts,processing-usage.module.ts}` and `backend/test/processing-usage.integration.mjs`.

**Modify:** `backend/src/admin-settings/processing-admission.service.ts`, `backend/src/jobs/{jobs.service.ts,job-actions.service.ts,job-deletion.service.ts}`, `backend/src/processing/processing.module.ts`, existing user account deletion orchestration, `backend/src/rate-limits/rate-budget.service.ts`, and related tests. Use the existing owner fence and unique job identity; do not implement a second independent auth/quota database.

- [ ] Add fake-clock tests for 3600 seconds/86400 seconds, reserved versus used amounts, 24-hour boundary, multiple replenishments, grandfathered unfinished jobs, and one account across sources/devices.
- [ ] Implement C2 methods with one transaction for job creation, usage hold, and owner fence. Replayed job requests and upload-url renewal must not reserve twice. Distinct simultaneous requests cannot both pass the one-unfinished-job limit.
- [ ] Wire settlement to cancellation/ready/failure/recovery hooks as an idempotent ledger operation. Record unknown outcomes as pending. Preserve enough minimal accounting after job deletion to prevent quota reset; integrate account-deletion retention rules.
- [ ] Expose owner-only usage with `no-store`, bounded replenishment schedule, and safe problems. A UI preflight result is nonbinding.
- [ ] Add separate atomic attempt counters using existing infrastructure. Exhausted allowance/full queue must not trigger unbounded automatic retries. Counter dependency failure must fail safely without creating unaccounted work.

**Required race assertion, implemented in the isolated integration harness:**

```js
const results = await Promise.allSettled([createJobAsSameOwner('request-a'), createJobAsSameOwner('request-b')]);
assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
assert.equal((await readOwnerUsage()).reservedAudioSeconds, 1800);
```

Define `createJobAsSameOwner`/`readOwnerUsage` in that test using the repository's isolated fixtures; also replay the winning request and assert the same job and unchanged hold. Mocks alone cannot prove transaction safety.

**Validation:** `npm test -- src/processing-usage/processing-usage.service.spec.ts src/processing-usage/processing-usage.controller.spec.ts`; `npm run build`; `node --test test/processing-usage.integration.mjs` with isolated services only.

**Acceptance:** no cross-device/source bypass, no double debit/refund, no early release for unresolved processing, and a clear private usage contract.

## B03 — Global workload admission and expiring upload reservations

**Depends on:** B02; R02 for enabled numerical budgets. **Consumes/produces:** C3 cost/capacity rules and C2 reservation lifecycle.

**Create:** `backend/src/processing-queue/{queue-capacity.schema.ts,queue-capacity.service.ts,queue-capacity.service.spec.ts,queue-cost.ts,queue-cost.spec.ts,processing-queue.module.ts}` and `backend/test/queue-capacity.integration.mjs`.

**Modify:** `backend/src/admin-settings/processing-admission.service.ts`, `backend/src/jobs/{jobs.service.ts,enqueue.service.ts,job-actions.service.ts}`, existing upload/reservation maintenance paths, and `backend/src/processing/processing.module.ts`. Identify and reuse the existing maintenance scheduler before adding a handler.

- [ ] Write tests for count, audio-seconds, and estimated-worker-seconds ceilings; account and global reservation must both succeed or neither may persist.
- [ ] Add a durable global fence/counter with unique per-job reservations. Include upload, queued, active, and unresolved work as defined in C3. Distinguish queue-only display totals.
- [ ] Check budgets before issuing a signed grant; validate upload-complete against immutable object/checksum/size. Configure grant renewal inside a bounded reservation lifecycle; renewals cannot extend abandoned holds indefinitely.
- [ ] Expire abandoned uploads and reconcile counters idempotently after crashes. Prove upload-complete versus expiry race yields either one accepted queue job or one expired cleanup path, never a free job with released counters. Local preparation has no capacity hold.
- [ ] Recompute admission availability when evidence/settings change, retaining accepted snapshots. Bound queue count even when declared durations are tiny. Refuse new work safely when estimate dependencies are unavailable; retain existing durable jobs.

**Concrete cost invariant:** `estimateCost(1800, model) >= estimateCost(300, model) > 0`; invalid/stale models do not return zero. Use an explicit test model `{referenceProcessingSecondsPerAudioSecond: 2, fixedJobOverheadSeconds: 10}` to assert costs 3610 and 610; these numbers are fixtures, not production measurements.

**Validation:** `npm test -- src/processing-queue/queue-capacity.service.spec.ts src/processing-queue/queue-cost.spec.ts`; `npm run build`; `node --test test/queue-capacity.integration.mjs` on isolated services.

**Acceptance:** concurrent different users cannot over-admit; no S3 grant on rejection; cleanup cannot leak/release another job's reservation.

## B04 — Fair queue selection and aging

**Depends on:** B03. **Consumes/produces:** C3 `selectNextEligible`, accepted cost model, trusted recent execution usage.

**Create:** `backend/src/processing-queue/{fair-queue.service.ts,fair-queue.service.spec.ts,queue-scheduling.schema.ts}` and `backend/test/fair-queue.integration.mjs`.

**Modify:** `backend/src/worker/worker-coordinator.service.ts`, `backend/src/jobs/{job.schema.ts,enqueue.service.ts}`, existing attempt execution settlement, and worker claim integration tests. Preserve transactional claim/generation fences and Redis notification/long-poll behavior.

- [ ] Write deterministic fake-clock selection tests: lower recent consumption wins, cost breaks equal-user-usage ties, aged eligible jobs win by oldest queue order, and cancellation/suspension/capability exclusions run before ranking.
- [ ] Implement C3 selection using indexed durable state. Avoid whole-history scans and in-memory sorting of all jobs; materialize recent consumption and eligibility fields with reconciliation checks.
- [ ] Enforce one running job per owner for grandfathered queues and concurrent workers. Claim increments selection accounting in the same transaction as assignment; failed claims do not advance it.
- [ ] Record actual processing time from all attempts for fairness. Do not equate returned/refunded audio allowance with zero consumed machine time. Retried jobs retain logical identity and cannot reset age unfairly or jump to the front.
- [ ] Test continuous short arrivals until an aged long job is selected; test two workers racing for the same job, user suspension during claim, and long admission pause preserving already accepted eligibility.

**Selection scenario to encode:** three eligible jobs with equal recent usage and costs `600, 60, 300` select `60`; if the `600` job is older than the aging threshold it selects first; an unavailable worker never claims an unsupported job even if aged.

**Validation:** `npm test -- src/processing-queue/fair-queue.service.spec.ts`; `npm run build`; `node --test test/fair-queue.integration.mjs test/worker-coordinator.integration.mjs test/worker-races.integration.mjs` on isolated services.

**Acceptance:** explicit fair ordering, no starvation under the documented assumptions, bounded indexed queries, no duplicate assignment, no claim of preempting a running long job.

## B05 — Worker capabilities, measured admission, and terminal settlement

**Depends on:** B02–B04. **Consumes/produces:** C4 `ProcessingAssignmentLimits`/`AttemptExecutionEvidence`, C2 settlement, C3 reconciliation.

**Modify:** `backend/src/worker/{worker-coordinator.service.ts,worker-output.service.ts,worker-terminal.service.ts,worker-registry.service.ts,worker-control.schema.ts,worker-registration.schema.ts,worker-recovery.service.ts,worker-routes.ts}`, existing worker DTOs/presenters, `backend/src/jobs/{job.types.ts,job-attempt.schema.ts}`, and protocol docs. Verify each named module before editing; reuse the existing outcome service if recovery responsibilities differ.

**Create:** `backend/src/worker/worker-capability-policy.ts`, `.spec.ts`, and `backend/test/worker-policy-v2.integration.mjs`.

- [ ] Add old/new worker and old/new job compatibility tests. Effective capability is registry-verified and assignment-fenced; a client or worker cannot self-authorize a higher limit/concurrency.
- [ ] Send accepted job limits and timeouts in the existing assignment envelope. Old jobs without v2 fields recover with old limits; v2 jobs are ineligible for unknown/legacy workers beyond those limits.
- [ ] Validate measured duration and actual bytes, reconcile account/global reservations, and authorize separation only after that transaction succeeds. Underdeclared files that cannot acquire sufficient budget stop before AI work.
- [ ] Accept idempotent bounded execution evidence with existing selectors. Reject nonfinite/negative/decreasing or impossible cumulative timings and stale attempt reports.
- [ ] Settle usage/capacity once for ready, user/admin cancellation, service failure, invalid input, expiry, and account deletion. Race cancellation with completion and output-finalization to prove only one terminal outcome wins. Unknown/offline/recovery states retain ownership until verified stop/reconciliation.
- [ ] Apply versioned output duration/bytes/S3 checks and failed-upload recovery. Do not rerun separation if a valid durable output can be reconciled and uploaded.

**Validation:** `npm test -- src/worker/worker-capability-policy.spec.ts`; `npm run build`; `node --test test/worker-policy-v2.integration.mjs test/worker-output.integration.mjs test/worker-recovery.integration.mjs test/worker-races.integration.mjs` on isolated services.

**Acceptance:** old workers never receive oversized jobs, understated metadata never reaches AI without accounting, and stopping/refunding/releasing capacity respects actual process evidence.

## B06 — Admin controls, usage APIs, observability, and backend handoff

**Depends on:** B01–B05. **Consumes/produces:** C6 routes, settings fields, account exceptions, queue/worker/user presenters, safe problems.

**Modify:** `backend/src/admin-settings/{processing-settings.service.ts,admin-settings.controller.ts,dto/processing-settings.dto.ts}`, `backend/src/admin-users/{admin-users.controller.ts,admin-users.service.ts,admin-users.presenter.ts,dto/admin-user.dto.ts}`, `backend/src/admin-jobs/{admin-jobs.controller.ts,admin-jobs-query.service.ts,admin-jobs.presenter.ts}`, `backend/src/admin-observability/{admin-overview.service.ts,health-sampler.service.ts}`, existing admin-worker presenters, and API/operations docs.

**Create:** `backend/src/admin-users/{processing-allowance-override.schema.ts,processing-allowance-override.service.ts,processing-allowance-override.service.spec.ts}`, `backend/src/admin-jobs/{queue-summary.service.ts,queue-summary.service.spec.ts}`, and `backend/test/media-policy-admin.e2e-spec.ts`.

- [ ] Test permission/fresh-auth matrices, expectedRevision conflicts, expired/revoked exceptions, idempotent operation receipts, and malformed settings/override values.
- [ ] Extend existing audited processing settings with policy/capacity/fairness knobs and explicit readiness status. Keep UI-independent backend ceilings; unknown evidence cannot be enabled by submitting a forged form value.
- [ ] Implement C6 expiring allowance overrides and optional temporary suspension through current permissions. Require expiry/reason, enforce expiry in requests/claims, and preserve newer manual suspension changes when an old timer expires. No exception bypasses physical/global limits.
- [ ] Expose bounded queue metrics: job count, declared/measured queued seconds, estimated work/range and confidence, oldest wait, short/long distribution, actual execution, capability-qualified worker slots, failure/stall indicators, and account rejection/cancellation summaries. Preserve existing paging/filtering and private media grants.
- [ ] Add safe source/usage/status fields to mobile job responses and owner usage. Estimate freshness and unavailable states are explicit; never send raw diagnostics or other users' information.
- [ ] Update API examples and produce backend contract fixtures for mobile/dashboard tasks. Include v1/v2, busy, quota exhaustion, stale evidence, pending settlement, and revision conflicts.

**Validation (backend cwd):** focused new Vitest tests; `npm run verify`; `npm run test:processing:integration` and `npm run test:dashboard:integration` on isolated services. Add new integration files to appropriate scripts when they are not automatically discovered. Do not invoke production integration settings to satisfy a check.

**Acceptance:** verified backend handoff before dashboard integration; settings really control admission, administrator actions are audited, and API estimates never overstate live hardware proof.
