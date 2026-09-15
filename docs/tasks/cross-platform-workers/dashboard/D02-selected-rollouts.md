# D02: Add worker groups, release publication and selected rollout controls Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Let the administrator choose exactly which workers receive a release and observe actual installation outcomes.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** B04

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create dashboard/src/features/worker-releases/ release list/detail, group editor, rollout preview/dialog/detail and API modules.
- Modify dashboard/src/app/router.tsx, app-shell.tsx and dashboard/src/api/contracts.ts.
- Create dashboard/src/features/worker-releases/rollout-dialog.test.tsx and release-detail-page.test.tsx.
- Reuse shared tables, dialogs, operation receipts and permission helpers; leave mobile releases behavior unchanged.

## Interfaces

- Consumes B04 release/group/snapshot/preview/rollout APIs and distribution verification receipts.
- Produces draft publication, explicit stable selection, target preview/confirmation, pause/retry and actual per-worker update visibility.

## Steps

- [ ] 1. Implement separate Workers release/group screens with explicit permissions and signed-artifact verification status. Do not put worker builds into the mobile release form.

- [ ] 2. Allow selected individual workers and saved groups; preview the resolved membership and profile-specific compatibility/exclusion reasons.

- [ ] 3. Require confirmation of the exact selection/revisions and clearly show that later group members will not join automatically.

- [ ] 4. Make publish, select stable, and target selected workers separate actions. Never infer global rollout from a publish response.

- [ ] 5. Display desired release versus reported running build, update stage, successful test/job evidence, safe failure and offline pending state.

- [ ] 6. Handle concurrent group edits, stale previews, superseded targets, lost mutation responses and explicit retry of quarantined candidates.

- [ ] 7. Keep pause/revoke/admin drain semantics visible. A paused rollout is not a claim that a running update was terminated.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Publishing a release does not target the fleet
  Given a verified draft contains Windows and macOS artifacts
  When the administrator publishes it
  Then no worker target changes
  Until the administrator confirms a selected rollout or stable-install action
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm test -- src/features/worker-releases/rollout-dialog.test.tsx src/features/worker-releases/release-detail-page.test.tsx
npm run typecheck
npm run lint
npm run build
```

## Completion evidence and limits

Explicit selected-target tests, stale membership/revision handling, real observed-versus-desired states and no mobile release regressions.

Avoid any hidden select-all behavior. A group label alone is not a reproducible rollout target.
