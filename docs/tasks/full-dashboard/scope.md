# Full MusicMute dashboard — approved scope

Status: the approved dashboard stack is React + TypeScript + Vite. The current request updates documentation only; frontend implementation remains paused until the user requests resumption and B18 passes. See [execution progress](execution.md). Hosting, live changes, commits and pushes remain excluded.

## Decisions and precedence

This package is the execution authority for the full dashboard and its administration APIs. Build backend APIs first, pass the backend handoff gate, then start the React web dashboard once implementation is resumed. The current documentation update does not resume implementation; commits, pushes, live changes, deployment, hosting setup and deletion of data are not.

The user accepted all recommendations from this task's questions, with two explicit changes: authorized administrators may play and download user inputs/results; hosting is managed by the user and must be excluded. Google sign-in, one initial privately configured owner, expandable administrator access, English dashboard, English release changelogs, light/dark themes, responsive desktop-first UI, CSV export, dashboard-only alerts, and no automatic history deletion are included.

Resolve older plans as follows:

- Reuse the release behavior from [app updates](../../superpowers/specs/2026-09-10-app-updates-design.md), but replace its equal-access allowlist with the permissions model below. Do not create both `dashboard_admins` and `admin_access`.
- Reuse the [worker design](../../superpowers/specs/2026-09-10-multi-machine-workers-design.md) for fleet ownership and strict stopped recovery. Its older dashboard-first sequencing is superseded for this package by the user's latest backend-first instruction. Do not start or modify the separate Windows-worker implementation while writing/executing dashboard tasks.
- Existing [update tracker](../app-updates.md) and Android/iOS update plans remain the owners of mobile UI/install/check-timer implementation. Cross-reference evidence; never implement the same release API or dashboard twice.
- `backend/docs/starter-plan.md` contains historical BullMQ/worker suggestions. Current source and backend instructions establish API-only Node, external Redis for security/readiness, MongoDB job coordination, and Windows audio workers. Do not reintroduce a Node audio consumer or another queue.
- Hosting, domain selection, routing the SPA in production, CapRover/Docker/archive changes, CI deployment, S3/IAM/CORS mutations and DNS are excluded. Document local runtime requirements only. Browser API origin and base path are configuration inputs with local development defaults, not hosting decisions.

## Architecture and source map

Backend: existing NestJS strict TypeScript/ESM, Mongoose/MongoDB transactions, existing Firebase identity verification, existing S3 transfer services and shared security Redis. Node `>=24 <25`, npm `>=11 <12` from the current manifest. Use `.js` import suffixes and existing DI conventions. Reinspect source before execution because other tasks are editing this checkout.

Source anchors verified while planning:

- `backend/src/auth/{auth.guard,firebase-identity.service,auth-request,auth.decorators}.ts`: identity and current app-account checks.
- `backend/src/users/{user.schema,account-access.service,user-identity-fence.service,account-deletion.service}.ts`: active/disabled/deleting and account-deletion fences.
- `backend/src/jobs/{job.schema,job-attempt.schema,job.types,job-state,jobs.service,job-actions.service,enqueue.service,jobs-query.service}.ts`: existing job state, FIFO, retry/cancel and ownership.
- `backend/src/worker/{worker-auth.guard,worker-coordinator.service,worker-control.schema,worker-recovery.service,worker-terminal.service,worker-output.service,worker-claim-wait.service}.ts`: currently singleton worker behavior; fleet support is a prerequisite for real multi-machine controls.
- `backend/src/app-policy/`, `backend/src/storage/storage-transfers.service.ts`, `backend/src/processing/processing-transactions.ts`, `backend/src/operations/`: reuse policies, pinned object identities, transactions and trusted CLI.
- No `dashboard/` package existed at planning time. Use React + TypeScript + Vite for the web dashboard, Tailwind CSS + shadcn/ui for accessible components, React Router for navigation, TanStack Query for server state and Firebase Web Authentication for Google sign-in. Use native fetch/XHR, browser audio/file/download APIs, and established open-source chart/hash packages where required. Verify compatibility and lock versions during D01. Preserve all approved functional acceptance criteria.

New backend feature folders: `admin/` (identity/access/audit/contracts), `admin-workers/`, `admin-jobs/`, `admin-users/`, `admin-settings/`, `admin-observability/`, `admin-exports/`, `releases/`. Thin controllers call cohesive services. Shared job services retain lifecycle authority; admin endpoints must not directly assign arbitrary job statuses.

Frontend: `dashboard/src/{app,auth,api,components,features,styles}` with colocated Vitest/React Testing Library tests, shared MSW fixtures under `dashboard/src/test/`, and Playwright browser tests under `dashboard/e2e/`. Feature folders mirror pages and own their tests. Create only shared components actually needed by these pages. Build a browser SPA that consumes NestJS directly; no Next.js server or native dashboard target is part of this scope.

## Permissions

Backend derives permissions from a stored role; browsers never supply effective grants. One role per administrator initially. Role names are `owner`, `release_manager`, `worker_manager`, `support`, `viewer`.

| Permission                      | Owner | Release manager | Worker manager | Support | Viewer |
| ------------------------------- | ----- | --------------- | -------------- | ------- | ------ |
| overview.read                   | Yes   | Yes             | Yes            | Yes     | Yes    |
| workers.read                    | Yes   | No              | Yes            | Yes     | Yes    |
| workers.manage, workers.recover | Yes   | No              | Yes            | No      | No     |
| jobs.read                       | Yes   | No              | Yes            | Yes     | Yes    |
| jobs.manage                     | Yes   | No              | Yes            | Yes     | No     |
| users.read                      | Yes   | No              | No             | Yes     | No     |
| users.processing.manage         | Yes   | No              | No             | Yes     | No     |
| media.read                      | Yes   | No              | No             | Yes     | No     |
| releases.read                   | Yes   | Yes             | No             | No      | Yes    |
| releases.manage                 | Yes   | Yes             | No             | No      | No     |
| settings.read                   | Yes   | No              | Yes            | Yes     | Yes    |
| settings.manage                 | Yes   | No              | No             | No      | No     |
| health.read, alerts.manage      | Yes   | No              | Yes            | No      | No     |
| audit.read                      | Yes   | No              | No             | No      | No     |
| exports.read                    | Yes   | No              | Yes            | Yes     | No     |
| admin.access.manage             | Yes   | No              | No             | No      | No     |

Exports also require the dataset's read permission. Workers/viewers see opaque user IDs on jobs; email/name expansion requires users.read. Media access is separate from job metadata and starts with Owner and Support. The user authorized admin media access, not exposure to ordinary accounts or public URLs. Owners can assign these roles; retain at least one active owner transactionally. Role defaults are documented implementation decisions under the accepted recommendation, not permission to silently change live access.

## Behavior and limits

- Preserve one processing slot and one warm vocals-only engine per machine. Initially 2–5 machines; test 20 identities without claiming measured production throughput. No shutdown, reboot, shell execution, worker binary installation, hardware telemetry or model-selection controls.
- FIFO applies to verified uploaded jobs. Admin retry creates a new linked job at the tail; only failed jobs with verified usable input are retryable. No priority/reorder/bulk-delete action.
- Known statuses: awaiting_upload, queued, validating, processing, uploading_result, interrupted, cancel_requested, ready, failed, cancelled. A cancellation request is not immediate proof that a worker stopped.
- Never unlock unfinished work solely because a lease expired, a key was revoked, or a worker is offline. Exact-attempt stopped recovery requires evidence and fresh admin authentication.
- Suspend processing separately from disabled/deleting account status. Suspension and maintenance block new reservations, renewal and retries, but preserve existing jobs, results, login and account-deletion flows. Uploads with reservations issued before suspension/maintenance may finish within their recorded expiry and immutable limits. Make that admission boundary explicit to users.
- Settings: acceptNewJobs, maintenanceMessageEn, maintenanceMessageAr (optional translation), maxInputBytesExclusive, maxDurationSecondsExclusive, maxActiveJobsPerUser (null = existing unlimited behavior). Initial maxima remain 30,000,000 bytes exclusive and 600 seconds exclusive. Reject settings above these existing worker/mobile ceilings; permit lowering without invalidating accepted work. Per-user active count includes awaiting_upload, queued, validating, processing, uploading_result, interrupted, cancel_requested.
- Settings and suspension participate in the same transaction conflict/fence as job admission; a read-only policy lookup is insufficient under concurrent updates. Each accepted reservation snapshots limits. No retention cap or automatic media/history deletion.
- Release sources: Android direct APK or Google Play, iOS App Store. Draft upload never changes mobile behavior. Publish/withdraw modifies policy atomically; published release content is immutable.
- Minimum build determines required updates; target build above installed determines optional updates. With minimum 10 and target 12, build 9 is required, 10/11 optional, 12/13 none. Reject target below minimum and unavailable channel targets.
- English changelog; APK maximum 256 MiB, upload grant 15 minutes, release download grant 60 minutes, local APK verifier deadline 90 seconds. Immutable S3 object version, checksum, package/build and signer verification are mandatory before publication.
- App checks at launch, every 15 minutes foreground/online, reconnect and due foreground entry; Later defers optional reminders for 24 hours. Known forced update remains blocking offline. Entire-app gate and installer/store handling belong to linked mobile plans. Existing submitted cloud jobs finish; backend refuses outdated new submissions.
- Dashboard has all nine main areas: Overview, Workers, Jobs, Users, Releases/Update Policy, Administrators, Settings, System Health/Alerts, Activity Log. Export is an action on overview/jobs, not an extra service.
- No real cloud billing estimates, no browser activity tracking, no outbound alerts. Report persisted processing-active users, not invented DAU or mobile-version adoption metrics.

## UX and verification

Use explicit permission-based navigation plus server enforcement, pagination, URL-backed filters, accessible tables/forms/dialogs, keyboard/focus support, light/dark themes and responsive layouts. Every data page includes loading, empty, error, stale and permission-lost states. No fake counts or pretend live controls when a dependency is unavailable.

Browsers may be tested locally with fixture auth and isolated APIs. Any future mobile/device tests are restricted to existing iPhone 17 Pro iOS 26.0 simulator UDID `$IOS_SIMULATOR_UDID`; if unavailable, record the blocker. Do not run another device or create/download a replacement.

No application tests are needed merely to write these Markdown plans. Implementation tasks require scoped tests first, full backend/frontend gates, and evidence. Never label a mocked check as live S3/Firebase/Windows/mobile proof.
