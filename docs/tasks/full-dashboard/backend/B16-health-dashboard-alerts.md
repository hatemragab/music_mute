# B16: System health and persistent dashboard alerts Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Surface meaningful worker, recovery, storage and APK issues without outbound notifications or expensive probes per browser.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B02](../backend/B02-audit-operation-receipts.md), [B05](../backend/B05-worker-admin-controls.md), [B12](../backend/B12-apk-upload-verification.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin-observability/admin-health.controller.ts, admin-health.service.ts, admin-alert.schema.ts, admin-alerts.service.ts, admin-alerts.controller.ts, health-sampler.service.ts and relevant *.spec.ts.
- Reuse current health/readiness, storage-preflight and worker registration/control services; add schema registration in admin-observability.module.ts.
- Create backend/test/admin-health.e2e-spec.ts and backend/test/admin-alerts.integration.mjs.

## Interfaces

GET /admin/health, GET /admin/alerts and POST acknowledge from contracts.md. Cached component checks carry checkedAt and unknown/degraded/unavailable status. Alert keys deduplicate type+resource; acknowledgments and resolutions are separate.

## Steps

- [ ] 1. Test startup unknown, temporarily unavailable dependency, enabled worker offline, deliberately draining worker, interrupted slot, rejected APK and recovery of each condition. Do not alert an idle intentionally revoked registration as a new outage.

- [ ] 2. Use existing bounded dependency probes with 2-second deadline, single-flight sampling and 30-second cache; storage probes are read-only and use known safe preflight paths. No host SSH, disk scan, credential value output or arbitrary remote probe URL.

- [ ] 3. Persist deduplicated condition transitions across API replicas with unique indexes and conditional updates. A condition's recurrence after resolution produces a new active episode or clears prior acknowledgment according to a documented deterministic rule.

- [ ] 4. Implement fresh observation/lastSeen timestamps and severity. Acknowledgment is an audited revisioned mutation available to Owner/Worker Manager; it never clears an active condition or frees a worker slot.

- [ ] 5. Suppress writes when no material state change occurred; no email, Slack, mobile push or scheduled external monitor. Keep alert history without automatic deletion.

- [ ] 6. Run isolated multi-replica sampler tests, repeated acknowledgment, timeout degradation and recovery; safe health output contains no infrastructure hostnames, connection strings or raw stack traces.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Two API replicas observing one outage create one active alert episode.
Scenario 2: Acknowledging a stuck worker leaves recoveryRequired=true and its slot reserved.
Scenario 3: A component that has never been checked is unknown, not healthy.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin-observability
npm run test:e2e -- test/admin-health.e2e-spec.ts
npm run build
node --test test/admin-alerts.integration.mjs
```

## Completion evidence

- [ ] Operators get actionable, deduplicated in-dashboard alerts and truthful bounded health observations.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
