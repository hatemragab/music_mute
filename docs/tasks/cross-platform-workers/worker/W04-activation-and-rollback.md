# W04: Implement transactional activation, recovery and permitted rollback Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** LOCALLY REVIEWED — [implementation and fix evidence](../evidence/W04-report.md), [independent review](../evidence/W04-review.md), and [actual control-client integration](../evidence/W04-control-client-integration.md). Concrete native runtime/bootstrap wiring, GPU and unattended boot remain downstream obligations.
**Goal:** Switch complete worker environments only at a safe assignment boundary and recover deterministically after crashes or reboots.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** W02, W03, B05

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker/musicmute_worker/update/coordinator.py, journal.py, activation.py and worker/tests/test_update_activation.py.
- Modify launcher.py and shared worker lifecycle to expose idle/cleanup/descendant-stop evidence.
- Create worker/tests/test_update_recovery.py and state-schema compatibility fixtures.
- Keep native service entrypoints fixed; activate a version through an atomic record rather than moving a venv.

## Interfaces

- Produces UpdateCoordinator.prepare/activate_when_idle/recover_interrupted_activation.
- Consumes PlatformAdapter containment, verified target records, current update policy and exact assignment/cleanup state. Emits contract-defined update stages.

## Steps

- [ ] 1. Persist an update journal before preparation and every activation transition, including old/candidate release IDs, runtime/model identities, policy revision and rollback permission.

- [ ] 2. Stage at permanent versioned paths without GPU load while a real job is active. Reserve disk space before large downloads/extraction.

- [ ] 3. Set a local no-new-claims hold without changing administrator desired state. Wait until the owned attempt is terminal, cleanup acknowledged and descendants verified stopped; unresolved recovery blocks switching.

- [ ] 4. Recheck selection/minimum/fallback policy immediately before activation. A paused/superseded rollout must not silently proceed using stale eligibility.

- [ ] 5. Run candidate model/service/authentication checks without real claims. Atomically record active release and obtain ready acknowledgement before resuming claims.

- [ ] 6. Recover power loss at every transition, choosing the last proven consistent state. Quarantine repeatedly failing candidates and restore the full permitted old environment when safe.

- [ ] 7. If a candidate already claimed work, stop and reconcile before rollback. If durable schema or policy excludes fallback, pause new claims and report repair-required; do not add state migrations.

- [ ] 8. Update the launcher through its own versioned bootstrap handoff and rollback record, after worker idle, so a launcher failure cannot remove the only recovery executable.

- [ ] 9. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Power fails after activation pointer changes
  Given the old release remains intact
  And the candidate has not completed readiness
  When the machine boots again
  Then the launcher reads the durable activation journal
  And restores or validates a permitted consistent release
  And no two releases can claim work concurrently
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_update_activation.py' -v
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_update_recovery.py' -v
```

## Completion evidence and limits

Fault injection before/after every durable write, cleanup/recovery blocking, prohibited fallback rejection and actual version observations.

A process exit alone is not assignment completion. Do not overwrite active dependencies or trust offline status as stop evidence.
