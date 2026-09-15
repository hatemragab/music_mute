# B04: Implement worker release records, groups, and selected targets Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** LOCAL IMPLEMENTATION REVIEWED; B05 claim enforcement is now reviewed. H01/H02 distribution wiring remains downstream. See [execution evidence](../evidence/B04-report.md).
**Goal:** Select exact signed releases for explicit worker snapshots while keeping new-install stable selection independent.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** B01

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create backend/src/worker-releases/ module, release/group/rollout schemas, services, controllers, DTOs and worker-rollouts.service.spec.ts.
- Create backend/test/worker-rollouts.integration.mjs.
- Modify backend/src/admin/admin-permissions.ts, configuration and module composition; use existing admin operation/audit patterns.
- Do not modify mobile app_releases to accept worker artifacts.

## Interfaces

- Consumes WorkerReleaseTarget, UpdateDecision, admin release/group/rollout routes and distribution receipts in contracts.md.
- Produces getUpdateDecision(workerId), preview/create/pause/retry rollout operations and stable-bootstrap metadata. Publication requires an authenticated verified artifact receipt, not caller-supplied checksum alone.

## Steps

- [x] 1. Implement immutable published metadata, increasing build numbers, unique release/profile artifacts, signed receipt verification, draft/published/withdrawn states and audited stable selection.

- [x] 2. Add revision-checked saved groups. Resolve selected groups and individual IDs into a deduplicated immutable membership snapshot with a maximum of 1000 workers.

- [x] 3. Preview each worker's compatibility, current state, selected target and exclusions. Confirm using expected group/worker/release policy revisions so a stale preview cannot silently target new members.

- [x] 4. Fence competing rollouts and explicit supersession. Pause prevents new activations and does not pretend a machine already activating has stopped.

- [x] 5. Expose only this authenticated worker's decision. Publishing an artifact or changing group membership never updates other workers automatically.

- [x] 6. Persist requested/downloaded/running/verified/failed states separately, including observed version, last event time and unknown/offline outcomes.

- [ ] 7. Enforce minimum-claim build and allowed fallback selection, including withdrawn/compromised releases. Retrying quarantined candidates requires an explicit audited operation.

  B04 implements targeted floor authority, allowed fallback filtering, withdrawal holds and audited selected retry. Actual fresh-claim enforcement is intentionally handed to B05 before pairing exposure.

- [x] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: A group changes after rollout selection
  Given a rollout captured workers A and B from group G
  When worker C is later added to G
  Then C receives no target from the existing rollout
  And A and B retain the originally confirmed target
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm test -- src/worker-releases/worker-rollouts.service.spec.ts
npm run build
node --test test/worker-rollouts.integration.mjs
```

## Completion evidence and limits

Revision race tests, stable-vs-targeted independence, no fleet-wide accidental assignment, monotonic builds and fallback policy fixtures.

Server configuration must constrain distribution origins; never fetch an administrator-provided arbitrary URL as a release-validation shortcut.
