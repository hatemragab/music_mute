# Worker clean-slate removal design

**Status:** Approved for design documentation on 2026-09-16. Implementation,
push, merge, deployment, and database cleanup are separate steps.

## Objective

Remove the current worker-machine implementation from the `main`-based
`codex/worker-clean-slate` branch so the next worker architecture starts from an
intentional, compile-safe boundary rather than inheriting the Z440 and later
fleet abstractions.

The current cross-platform implementation remains available only as the remote
reference branch `origin/codex/cross-platform-worker-fleet`. It is not merged
into this cleanup branch. After the cleanup is implemented, validated, reviewed,
and locally committed, create a new branch from that clean commit for the worker
redesign. The recommended name is `codex/worker-redesign`; branch creation is not
part of this removal step.

## Confirmed decisions

- Remove the complete current worker runtime, worker API, administrator worker
  API, dashboard worker UI, worker persistence registrations, worker queue and
  ownership logic, worker configuration, and worker-specific tests and docs.
- Delete the complete tracked `windows-worker/` directory.
- Preserve `backend/separate.py` in its current location and do not modify its
  contents. It is the only current worker-side implementation intentionally
  carried forward for possible reuse during the later redesign.
- Do not modify any file under `android/` or `ios/`.
- Do not add a database migration, cleanup command, startup mutation, or drop
  operation. The user will remove obsolete local MongoDB data manually.
- Breaking backend and dashboard changes are accepted because the product has
  not launched and has no users.
- Keep the work local on the cleanup branch unless the user later requests a
  push, pull request, merge, or deployment.

## Approach

Use a hard-removal approach. Delete old concepts at their source and repair the
remaining product around the missing processing executor.

Two alternatives were rejected:

1. A compatibility shell would keep the old schemas, routes, or adapters for a
   future implementation, but those contracts would constrain the redesign.
2. Hiding only the dashboard would leave obsolete authentication, ownership,
   queue, lease, and recovery behavior active in the backend.

Hard removal makes the temporary product state honest: stored job history and
completed output access remain available, while no machine can authenticate,
claim, execute, recover, or report work.

## Route contract

### Routes to delete

Delete the controller registration and implementation for every route below.
They must resolve through the normal Nest not-found behavior; do not add
redirects, deprecation handlers, compatibility responses, or placeholder
controllers.

Worker protocol routes:

- `POST /api/v1/worker/identity`
- `POST /api/v1/worker/output-url`
- `POST /api/v1/worker/complete`
- `POST /api/v1/worker/local-cleanup`
- `POST /api/v1/worker/fail`
- `POST /api/v1/worker/cancelled`
- `POST /api/v1/worker/reconcile`
- `POST /api/v1/worker/claim`
- `POST /api/v1/worker/heartbeat`
- `POST /api/v1/worker/stage`

Administrator worker routes:

- `GET /api/v1/admin/workers`
- `GET /api/v1/admin/workers/:id`
- `POST /api/v1/admin/workers`
- `PATCH /api/v1/admin/workers/:id`
- `POST /api/v1/admin/workers/:id/drain`
- `POST /api/v1/admin/workers/:id/enable`
- `POST /api/v1/admin/workers/:id/rotate-key`
- `POST /api/v1/admin/workers/:id/revoke`
- `POST /api/v1/admin/workers/:id/release-stopped`

Delete the dashboard routes `/workers` and `/workers/:id`, their lazy imports,
navigation entry, route guards, API client functions, dialogs, pages, fixtures,
and route tests.

### Job routes to preserve

The worker routes above are different from the authenticated user job contract.
Keep these job operations working for retained history and storage management:

- `GET /api/v1/jobs`
- `GET /api/v1/jobs/:id`
- `POST /api/v1/jobs/:id/download-url`
- `PATCH /api/v1/jobs/:id`
- `POST /api/v1/jobs/:id/cancel`
- `DELETE /api/v1/jobs/:id`

The current class-level processing guard must not block those retained
operations.

Keep these mobile-facing route shapes, but make them reject before creating,
reserving, or mutating processing work:

- `POST /api/v1/jobs`
- `POST /api/v1/jobs/:id/retry`
- `POST /api/v1/jobs/:id/upload-url`
- `POST /api/v1/jobs/:id/upload-complete`

They return HTTP `503` with the existing safe error code
`PROCESSING_UNAVAILABLE`. Implement this at one small processing-execution
boundary. The source must contain the intentional marker
`TODO(worker-redesign)` so the new architecture has one discoverable integration
point. This is the only approved worker-redesign TODO in the cleanup.

## Backend removal

### Worker protocol and administration

Delete the dedicated `backend/src/worker/` and
`backend/src/admin-workers/` implementations and remove their module imports,
providers, guards, controller registrations, DTOs, presenters, and exports.
Remove worker-key authentication and all legacy/fleet mode selection.

Remove the worker environment variables and validation:

- `PROCESSING_WORKER_KEY_SHA256`
- `PROCESSING_WORKER_AUTH_MODE`
- `PROCESSING_WORKER_MAX_WAITERS`

Remove their example-environment entries, tests, scripts, and operational docs.
No worker secret or machine identity remains accepted by the API.

### Persistence

Stop registering or reading the dedicated worker protocol collections:

- `audio_workers`
- `audio_worker_control`
- `audio_job_attempts`
- `audio_job_receipts`

Delete their Mongoose schemas and the services built around them. Remove worker
ownership and lease fields from the `audio_jobs` schema and its indexes,
including `workerId`, `attemptId`, `sessionId`, `generation`, and
`leaseExpiresAt`. Remove worker-attempt output reservations and worker execution
evidence where they exist only to authorize the deleted protocol.

Keep finalized input/output object identity, job ownership by user, display
metadata, result history, storage cleanup state, usage records, safe job errors,
and notification data required by the retained job operations. Strip
attempt/generation fields and interruption-only values from retained error or
audit schemas when they have no non-worker consumer.

Do not alter MongoDB directly. Removing schemas and indexes from application
code does not authorize dropping the existing collections or indexes from any
database.

### Queue, execution, and recovery

Delete the current:

- FIFO/fair-queue claim selection and queue-capacity estimation;
- worker claim waiting and waiter admission;
- assignment ownership and execution attempts;
- session/generation fencing;
- heartbeat and lease handling;
- stage reporting and execution evidence;
- output reservation and worker completion receipts;
- interruption, reconcile, stopped-process, and worker recovery flows;
- worker availability and qualification calculations;
- worker migration and audit operations.

Retain only non-worker services needed by the preserved job/history, private
storage, usage, notification, cancellation, deletion, and account-deletion
flows. Refactor those consumers to stop querying removed collections rather
than leaving empty worker adapters.

### Processing settings and administration

Remove worker capacity, qualification evidence, worker-cost estimation,
fair-queue policy, and worker readiness from backend processing-settings
contracts. Preserve independent account access controls, media limits, usage
allowances, release management, application policy, and other non-worker
administration.

Remove the `worker_manager` administrator role and the permissions
`workers.read`, `workers.manage`, and `workers.recover`. Recalculate remaining
role descriptions and permission tests without silently granting replacement
permissions.

Remove worker-specific audit actions, stopped-worker evidence, offline/recovery
alerts, health checks, overview metrics, job filters, attempt timelines, and CSV
columns. Preserve the equivalent non-worker audit, health, job, storage, user,
release, and export behavior.

## Dashboard removal

Delete `dashboard/src/features/workers/` and all imports or links to it. Remove:

- Workers navigation and routing;
- worker registration, key display, state transitions, and recovery dialogs;
- worker status badges and polling;
- worker identity filters and links on job pages;
- worker/attempt fields in contracts and fixtures;
- worker counts on overview cards;
- worker health and offline alert presentation;
- worker capacity and qualification controls in processing settings;
- worker-specific audit labels and CSV expectations;
- worker roles and permissions from administrator management.

The remaining dashboard must continue to build and provide its non-worker pages.
Jobs may still show their status and final output/error information, but must not
show machine ownership or attempt history.

## Worker package and separation implementation

Delete all tracked files under `windows-worker/`, including PowerShell setup,
autostart, configuration, Python runtime, transport, packaging, benchmarks, and
tests.

`backend/separate.py` remains byte-for-byte unchanged. The cleanup must not wire
it into the NestJS process, expose it through an HTTP route, or invent a new
runner. Reusing it belongs to the later worker-redesign branch.

## Documentation and scripts

Delete prior dedicated worker/fleet/Z440 design documents, implementation plans,
task trackers, migrations, audits, and validation reports from this branch.
Retain this clean-slate specification and its later cleanup implementation plan
as the record of why the old subsystem was removed.
Edit shared documentation so it no longer claims that a Windows worker, fleet,
claim queue, worker dashboard, or worker configuration is currently supported.
Shared docs should state that new processing is temporarily unavailable pending
the redesign while history and completed result access remain supported.

The remote reference branch is the archive for the removed worker work. Do not
copy the old designs into a compatibility or archive directory on this branch.

## Testing strategy

Delete worker-only unit, E2E, integration, fixture, migration, and Python tests.
Update shared tests to remove worker assumptions while retaining coverage for
job history, downloads, rename, cancellation, deletion, storage cleanup, usage,
notifications, account deletion, admin jobs, and other surviving behavior.

Add focused backend tests proving:

1. old `/worker/**` and `/admin/workers/**` routes are absent;
2. job creation, retry, upload grant renewal, and upload completion return
   `503 PROCESSING_UNAVAILABLE` without writing processing state;
3. job list, detail, completed-result download, rename, cancel, and delete remain
   available under their existing authorization rules;
4. startup no longer requires worker credentials or registers worker models;
5. account and storage cleanup do not query deleted worker collections.

Update dashboard tests to prove the worker routes/navigation are absent and the
remaining pages render without worker contract fields.

Run the backend formatter and full `npm run verify`, then the dashboard formatter
check, linter, typecheck, tests, and build. Run focused integration suites where
their local MongoDB/Redis prerequisites are available. Compare the final diff to
verify there are no changes under `android/` or `ios/`, and verify
`backend/separate.py` has no diff.

## Acceptance criteria

- No tracked `windows-worker/` file remains.
- `backend/separate.py` is unchanged.
- No Android or iOS file changes.
- No `/worker/**`, `/admin/workers/**`, `/workers`, or `/workers/:id` route remains.
- No worker bearer authentication, registry, control, claim, lease, attempt,
  receipt, recovery, capacity, or qualification implementation remains.
- The backend no longer registers the four removed MongoDB collections and does
  not require any worker environment variable.
- No worker role, permission, dashboard page, navigation item, filter, metric,
  alert, audit action, or export field remains.
- New/retried/uploaded processing work fails safely with
  `503 PROCESSING_UNAVAILABLE` at one documented boundary.
- Retained job history, completed downloads, metadata changes, cancellation,
  deletion, storage cleanup, usage, and notifications pass their relevant tests.
- Backend and dashboard validation pass locally.
- The implementation commit remains local until the user requests otherwise.

## Explicitly out of scope

- Designing or implementing machine pairing, enrollment, credentials, hardware
  qualification, scheduling, execution, recovery, updates, or installers.
- Choosing final worker protocol or persistence contracts.
- Running, editing, or wrapping `backend/separate.py`.
- Editing Android or iOS.
- Modifying or deleting MongoDB data or indexes.
- Pushing, opening a pull request, merging, or deploying.
- Creating the future worker-redesign branch before this cleanup is implemented,
  validated, reviewed, and committed.
