# D03: Show worker qualification, update health and 30-day event timelines Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Make installation, GPU/boot qualification, runtime and update failures inspectable in one worker detail flow.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** B01, B03, D01, D02

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Modify dashboard/src/features/workers/workers-page.tsx, worker-detail-page.tsx, worker-status.ts and workers-api.ts.
- Create dashboard/src/features/workers/worker-events-panel.tsx and worker-events-panel.test.tsx.
- Modify dashboard/src/api/contracts.ts only for the declared runtime/event shapes.
- Create dashboard/src/features/workers/worker-detail-page.test.tsx.

## Interfaces

- Consumes current WorkerRuntimeReport summaries, B03 paginated events and B04 rollout observations.
- Produces filtered installation/startup/processing/update/cleanup timeline plus separate connection, assignment, qualification and release states.

## Steps

- [ ] 1. Add actual OS/GPU/provider/profile/model/build and boot-evidence information to worker detail; keep reported data distinguishable from independently qualified recipe evidence.

- [ ] 2. Show unavailable CPU/GPU memory, power and temperature values as unavailable, never zero. Do not add fabricated live metrics unsupported by an adapter.

- [ ] 3. Render event category/stage/status/operation filters, received and occurred times, retry chains and dropped-event notices with bounded pagination.

- [ ] 4. Retain earlier failures when later retries succeed; highlight the current operation result separately. An offline worker may still own a reserved attempt.

- [ ] 5. Keep event lists constrained to backend-authorized 30-day data and indicate retention clearly. Refresh pages without duplicate IDs or scroll resets.

- [ ] 6. Show ready, updating, blocked, drained, revoked and recovery-required reasons without changing existing recovery semantics.

- [ ] 7. Add tests for missing metrics, out-of-order/replayed events, empty expired history, unapproved installation linkage and safe diagnostic rendering.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Worker stops reporting while it owns a job
  Given the last event is processing started
  And no recent heartbeat exists
  When the dashboard refreshes
  Then it shows offline with outcome unknown and reserved ownership
  And does not report processing stopped or update completed
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm test -- src/features/workers/worker-events-panel.test.tsx src/features/workers/worker-detail-page.test.tsx
npm run typecheck
npm run lint
```

## Completion evidence and limits

Unknown-state and retention UI fixtures, operation timelines and safe metric handling, plus focused browser screenshots free of credentials.

Do not conflate a connected launcher with a qualified healthy GPU engine or a completed real processing job.
