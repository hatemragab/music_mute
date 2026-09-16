# B17: Bounded safe CSV exports for jobs and statistics Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Export the approved filtered operational data without user audio/personal details, formula injection or silent truncation.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B02](../backend/B02-audit-operation-receipts.md), [B15](../backend/B15-overview-statistics.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin-exports/admin-exports.module.ts, admin-exports.controller.ts, admin-exports.service.ts, csv-encoding.ts and corresponding *.spec.ts.
- Consume admin-jobs-query.service.ts and admin-overview.service.ts projections without duplicating authorization.
- Create backend/test/admin-exports.e2e-spec.ts and backend/test/admin-exports.integration.mjs.

## Interfaces

GET /admin/exports/jobs.csv and /overview.csv. Fixed headers: jobs=id,userId,status,workerId,createdAt,queuedAt,startedAt,finishedAt,elapsedSeconds,errorCode; overview=bucketStart,submitted,completed,failed,cancelled. Response attachment CSV, <=10,000 rows and <=90-day range.

## Steps

- [x] 1. Write golden encoding tests for comma, quotes, CR/LF, Unicode and cells beginning =,+,-,@,TAB,CR. Neutralize formula prefixes before CSV escaping; preserve documented machine-readable date/number columns.

- [x] 2. Require exports.read plus dataset read permission and limit export rate. Exclude emails/names, media names/URLs, object keys, reasons and infrastructure metadata regardless of actor.

- [x] 3. Collect at most cap+1 projected rows under bounded consistent read semantics, fail EXPORT_TOO_LARGE before writing headers when over cap, and use finite query/memory/time budgets. Do not silently truncate or create another queue/background export service.

- [x] 4. Record authorized actor, dataset, UTC filter interval and row count in a safe audit event before emitting output. Audit failure aborts export; no stored signed export files or retained CSV copy.

- [x] 5. Honor frontend filters and deterministic column order, encode UTF-8, sanitize generated filename and no-store header. Document null values and timestamp format.

- [x] 6. Test forbidden roles, expired sessions, malformed ranges/cursors, exact-cap and cap+1, client disconnect and dataset changes during snapshot acquisition.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: A malicious string beginning =HYPERLINK is emitted as a safe literal cell.
Scenario 2: 10,001 matching jobs produce a clear 422 before any partial CSV is sent.
Scenario 3: Support export contains opaque userId but never the user email or a media URL.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin-exports
npm run test:e2e -- test/admin-exports.e2e-spec.ts
npm run build
node --test test/admin-exports.integration.mjs
```

## Completion evidence

- [x] Reports are permission-scoped, bounded, formula-safe and faithfully use the selected filters.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.

Local evidence (2026-09-11, working tree based on `719b39be0d8d0a3b01a94d43ee66cfc039651e7c`; no commit/deployment):

- Added `backend/src/admin-exports/`, HTTP and compiled integration fixtures; added safe export metadata to shared audit records and snapshot-series access to the overview service.
- `npm test -- src/admin-exports`: 18 passed. `npm run test:e2e -- test/admin-exports.e2e-spec.ts`: 3 passed. `npm run typecheck`: passed.
- Coordinator rebuilt and ran `node --test test/admin-exports.integration.mjs`: 6 passed (parent plus 5 scenarios). Real isolated Mongo replica set covers exact 10,000 rows, cap+1 rejection, empty filtered exports, UTC overview, first-attempt start after recovery, concurrent changes under a snapshot, audit failure and disconnect.
- Jobs use one positively projected, capped aggregate envelope with the first attempt joined inside the same transaction. This avoids a driver `getMore` deadline incompatibility without removing transaction or 5-second query limits. CSV memory is capped at 8 MiB; overflow returns 422 before headers.
- CSV is UTF-8 without BOM, uses CRLF, ISO UTC timestamps, empty nulls, a fixed header order and apostrophe-prefixed formula-like string cells. User identifiers are opaque; no names, email, object identities or signed media URLs are projected.
- The connected compiled workflow also exercised CSV and its committed audit record. These are synthetic local fixtures; no live account, S3 or deployed dashboard proof is claimed.
