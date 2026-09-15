# B05: Enforce GPU, boot, build, and media eligibility at claim time Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** LOCAL IMPLEMENTATION REVIEWED. Both scoped review findings are fixed; 59 focused tests and isolated readiness integration pass. Full fleet-only processing fixtures remain B06 work. See [report](../evidence/B05-report.md) and [review](../evidence/B05-review.md).
**Goal:** Make readiness and update policy affect real claims without stranding existing attempts or rewriting queue fairness.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** B01, B04, F01

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Modify backend/src/worker/worker-coordinator.service.ts, worker-registry.service.ts, worker-claim-wait.service.ts and worker-recovery.service.ts.
- Modify backend/src/processing-queue/fair-queue.service.ts and queue-capacity.service.ts; preserve user-running and fairness behavior.
- Create backend/src/worker/worker-readiness.service.ts and worker-readiness.service.spec.ts.
- Create backend/test/worker-readiness.integration.mjs.

## Interfaces

- Consumes getUpdateDecision(workerId), runtime/profile qualification and existing assignment selectors.
- Produces evaluateNewClaim(workerId, session) -> allowed/reasonCodes and media-class eligibility. Gates are checked transactionally with controlRevision, not only at dashboard display time.

## Steps

- [ ] 1. Deny fresh claims for missing/expired runtime, CPU-only/unknown qualification, unverified boot, update hold, prohibited build, incompatible profile, drain/revoke or reserved ownership.

- [ ] 2. Within protocol 3, keep valid owned heartbeat, stage, completion, local-cleanup and recovery possible when the worker build floor rises. Breaking protocol changes require a coordinated idle development restart, not compatibility code.

- [ ] 3. Race new claims against target changes, readiness changes, revocation, and two API instances; every successful claim must satisfy the committed state.

- [ ] 4. Integrate newly qualified workers with versioned-media scheduling in the new schema. Preserve audit-quality admission information while allowing revisioned worker qualification; no historical backfill or old-schema decoder is required.

- [ ] 5. Ensure a new worker cannot receive long-media jobs based solely on the short installer fixture. Preserve the one-running-job-per-user rule and existing scheduling order.

- [ ] 6. Keep mobile availability truthful about qualified available capacity without exposing worker IDs or implying stale/offline processes stopped.

- [ ] 7. Add exact reason codes for idle no-job, policy hold, unsupported profile, and recovery-required; do not return a generic capacity failure for all cases.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Minimum build rises during an active job
  Given worker A owns a valid job on build 100
  When minimumClaimBuild becomes 101
  Then A may heartbeat, finish, clean up and reconcile its owned job
  But A cannot claim a different job on build 100
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm test -- src/worker/worker-readiness.service.spec.ts
npm run build
node --test test/worker-readiness.integration.mjs
npm run test:processing:integration
```

## Completion evidence and limits

Two-instance claim races, same-protocol owned-attempt completion and measured-media eligibility fixtures. Current fairness regressions remain passing.

Readiness must be fenced with claim ownership; a free-standing read followed by assignment leaves a time-of-check race.
