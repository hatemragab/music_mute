# Dashboard API

This is the current backend handoff for the private React administrator dashboard.
Paths are relative to `/api/v1`. Send the current Firebase ID token as
`Authorization: Bearer <token>`. Every `/admin/*` response is `Cache-Control:
no-store` and requires an enabled administrator record whose UID and normalized
verified Google email still match Firebase.

The dashboard must treat server permissions, revisions, and lifecycle state as
authoritative. Mutations marked fresh require recent Google authentication.

## Shared wire rules

Pages return `{items,nextCursor,asOf}`. Cursors are opaque and bound to their
filters. Revisioned writes require a nonnegative `expectedRevision`, UUID v4
`operationId`, and a bounded nonblank `reason`. Reusing an operation ID with a
different normalized request conflicts. A lost response may be reconciled through
the operation receipt; signed URLs never appear in receipts.

## Current administration areas

- administrator session and access management;
- overview metrics and bounded CSV exports;
- retained job history, cancellation, and deliberate private-media grants;
- user processing access, account recovery, and usage/allowance controls;
- release records, private APK verification, publication, and update policy;
- basic processing admission settings;
- health alerts and audit history.

Roles are `owner`, `release_manager`, `support`, and `viewer`. At least one active
owner is preserved. The API derives all permissions from the stored role; the
browser never supplies effective grants.

There is no machine administration, registration, key, recovery, attempt, queue
workload, or execution-control surface. New user processing creation and retry are
temporarily unavailable while the execution architecture is redesigned.

## Security boundaries

Private media grants require both job-read and media-read authority plus fresh
authentication. Release and account-recovery mutations also require their scoped
permissions and fresh authentication. Every privileged mutation is audited without
tokens, signed URLs, private object keys, or raw provider failures.

The route snapshot in `test/fixtures/dashboard-contracts/routes.json` is the
machine-readable inventory used by the isolated contract tests. Update that
fixture only from the compiled current source.

## Validation boundary

Dashboard unit, browser-fixture, and isolated backend suites prove local contract
behavior only. They do not prove live Firebase, S3, maintained signer compatibility,
production data, or deployment.
