# D01: Add pending installations and code-based worker approval Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Approve trusted installations by code and inspect failures that occur before a worker exists.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** B02, B03

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create dashboard/src/features/workers/installations-page.tsx, installation-detail-page.tsx, installation-approval-dialog.tsx and installations-api.ts.
- Modify dashboard/src/app/router.tsx, app-shell.tsx, dashboard/src/api/contracts.ts and existing worker registration entry.
- Create dashboard/src/features/workers/installation-approval-dialog.test.tsx and installation-detail-page.test.tsx.
- Remove the obsolete normal raw-secret registration UI; retain existing audited rotation/recovery controls.

## Interfaces

- Consumes safe pending installation/detail/event pages and approve/reject/status contracts from B02/B03.
- Produces Pending installations navigation and a code-entry approval flow linked to the resulting worker without exposing any permanent credential.

## Steps

- [ ] 1. Add typed API contracts and query keys, then tests for role denial, loading, error, empty state and paginated pending installations.

- [ ] 2. Show setup stage, reported OS/GPU, qualification/boot results, last received event and outcome unknown for interrupted reporting.

- [ ] 3. Require code entry in the approval dialog; show a safe machine summary before confirming, and use the existing fresh-auth challenge for approval.

- [ ] 4. Handle expired/invalid/used codes and revision conflicts without leaking code existence or repeating side effects. Clear the code from UI state after completion.

- [ ] 5. After a lost response, resolve the operation receipt and refresh detail; do not ask the operator to create another worker or repeat secret handling.

- [ ] 6. Link successful installation history to the permanent worker. Display pending permanent-auth readiness separately from administrative approval.

- [ ] 7. Add accessible form errors, keyboard focus restoration, responsive detail layout and test coverage using synthetic codes only.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Installer failed before pairing
  Given a pending installation stopped at dependency setup
  When an authorized administrator opens Pending installations
  Then the failed stage and safe diagnostic are visible
  And the UI does not label it as an approved or ready worker
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm test -- src/features/workers/installation-approval-dialog.test.tsx src/features/workers/installation-detail-page.test.tsx
npm run typecheck
npm run lint
npm run build
```

## Completion evidence and limits

Component/contract tests for expired codes, lost responses and interrupted setup; browser proof of the new flow with synthetic records.

Do not create a separate administration site or store pairing codes in URLs, analytics, local storage or screenshots used as public evidence.
