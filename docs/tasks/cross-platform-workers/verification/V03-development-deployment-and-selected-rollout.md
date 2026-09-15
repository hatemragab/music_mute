# V03: Prepare the authorized development deployment and first selected rollout Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Make the development launch and selected-worker proof concrete and reviewable without migrations or premature operational actions.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** V01, V02, H02

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create docs/tasks/cross-platform-workers/evidence/development-release-checklist.md and worker-distribution deployment/runbook sections.
- Update backend/docs/worker-fleet.md and worker/docs/install.md with only the new contract and approved domain.
- Record artifact digests, API compatibility/builds, selected machine IDs and observed outcomes without credentials.
- Create no migration, backfill, legacy adapter, or automatic reset script.
- Create worker-distribution/scripts/check-deployment.mjs as a read-only artifact/HTTPS verifier and docs/tasks/cross-platform-workers/evidence/development-release.json when real build identities exist.

## Interfaces

- Consumes verified packages, real GPU/boot evidence, clean new-protocol test fixtures and the signed distribution app package.
- Produces a reviewable authorized execution sequence and later evidence of exact deployed artifacts, HTTPS endpoints, new code pairing, job processing and selected rollout.

## Steps

- [ ] 1. Prepare a deployment manifest containing exact backend/dashboard/distribution/worker builds, signatures, profile reports, required configuration names and selected test machines. Keep values/secrets external.

- [ ] 2. Before asking to deploy, complete all local packages/tests and identify incompatible development data or old installers. Report exact manual reset/re-enrollment requirements; do not erase data or write migration code.

- [ ] 3. Obtain separate explicit authorization for deployment, DNS/app configuration and any required destructive development reset. Planning/implementation alone is not that authorization.

- [ ] 4. When authorized, stop new work and verify no unfinished assignment or descendants remain before a breaking coordinated backend/worker restart. Existing physical Z440 uses the new native installer and pairing flow.

- [ ] 5. Deploy the separate CapRover app with persistent storage and HTTPS at updates.music-mute.com, verify public installer/trust URLs, then deploy the matching backend/dashboard contracts and signed stable artifacts.

- [ ] 6. Pair only approved development machines, prove a job from each qualified platform and the dashboard setup/runtime logs, then target an explicitly selected group with a newer release.

- [ ] 7. Verify unselected workers stay unchanged, restart/reboot update recovery works, old/prohibited builds cannot claim, and 30-day log expiry is enforced. Report installed/running/job-verified and unavailable states separately.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Development state is incompatible with the new protocol
  Given old worker records or local journals prevent a new installation
  When deployment preparation detects them
  Then the operator receives an exact reset or re-enrollment requirement
  And no data is automatically deleted
  And no migration or legacy compatibility path is created
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
node worker-distribution/scripts/check-deployment.mjs --manifest docs/tasks/cross-platform-workers/evidence/development-release.json
```

## Completion evidence and limits

Reviewable manifest before authorization; afterwards, verified domain/HTTPS/artifacts, native approved-worker cycles and selected-rollout read-back. Run the read-only verifier from the repository root; it consumes reviewed manifest values and must not print credentials.

If authorization or hardware is absent, leave deployment/native proof pending. Do not mark the whole feature complete merely because code or docs exist.
