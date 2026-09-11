# B11: Release records and compatible public update policy Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Provide one immutable release model and update-policy authority for Android direct/Play and iOS App Store.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B01](../backend/B01-admin-identity-permissions.md), [B02](../backend/B02-audit-operation-receipts.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create or reuse backend/src/releases/release.types.ts, release.schema.ts, release-upload.schema.ts, release-policy.ts, release-policy.service.ts, releases.module.ts, app-updates.controller.ts, admin-releases.controller.ts, release-drafts.service.ts and dto/release-draft.dto.ts.
- Modify backend/src/app-policy/app-policy.schema.ts, access-policy.ts, app-policy.presenter.ts and app-policy.service.ts only for compatible stored selections.
- Create release-policy.spec.ts, release-drafts.service.spec.ts under backend/src/releases/; backend/test/admin-release-drafts.e2e-spec.ts and backend/test/app-updates.e2e-spec.ts.

## Interfaces

ReleaseSummary and UpdatePolicySnapshot; release list/create/detail/draft edit and public GET /app-updates/policy from contracts.md. Map older UPD-B02 work here; do not create a parallel release collection or policy presenter.

## Steps

- [ ] 1. Reinspect prior release task progress and reuse delivered code. Add pure update-decision tests: builds 9/10/12/13 against minimum 10 target 12, no policy, invalid target below minimum and channel mismatch.

- [ ] 2. Create indexed release/upload models with unique platform/source/build; published payload immutable. Validate version/build/plain-English changelog and official store URL/app identity, rejecting arbitrary download hosts or HTML.

- [ ] 3. Implement admin draft/list/detail/edit with grants, operation receipts and revision conflicts. Editing artifact identity after verification is rejected; changes that require a new binary need a new draft/build.

- [ ] 4. Extend stored policy using optional selections while legacy presenter emits its existing exact shape. Preserve requireVerifiedEmail and existing feature-disabled/minimum enforcement behavior; never silently clear legacy restrictions.

- [ ] 5. Implement public rate-limited no-store snapshots without Firebase sign-in. Direct/Play/App Store routing and absent/unavailable target handling follow the existing approved update design.

- [ ] 6. Run legacy auth/policy and public update contract tests, including old stored documents and unknown platform/distribution. No draft operation publishes mobile behavior.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Build 9 is required, 10 optional, 12 none and 13 none for minimum 10 target 12.
Scenario 2: An iOS direct_apk draft is rejected; a published draft cannot be edited.
Scenario 3: Creating a draft leaves the previously published policy revision and target unchanged.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/releases src/app-policy
npm run test:e2e -- test/admin-release-drafts.e2e-spec.ts test/app-updates.e2e-spec.ts
```

## Completion evidence

- [ ] One versioned release authority works for new clients while old policy responses stay compatible.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
