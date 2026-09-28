# Administrator push notifications — local validation

Date: 2026-09-29. Branch: `admin-push-notifications`, based on fetched
`origin/main` at `1ac92dad56dab45235926994d9af7a9b920cd368`.
Validation below was performed in the isolated feature worktree before publication.
No deployment, real-user broadcast or production mutation was made.
The primary checkout's concurrent work was preserved.

## Delivered behavior

- Owner-only dashboard navigation, title/message composition, notification preview,
  reviewed confirmation, fresh Google authentication and required audit reason.
- Audited operation IDs deduplicate submission; unresolved receipt recovery blocks
  another broadcast in the current page session.
- Durable bounded registration snapshots, per-binding attempts, renewable replica
  leases, transient retries, exact-binding invalidation and active-account checks.
- Account deletion fences new recipient records and purges existing per-account
  delivery records. Counts exclude subsequently purged accounts.
- Paginated broadcast history over the existing authenticated raw WebSocket, with
  per-device pending, FCM-accepted, exhausted, invalid and skipped counts. No polling.
- Additive OpenAPI/HTTP and realtime contracts; no dependency or environment changes.

## Commands and observed results

From `backend/`:

- `pnpm run verify`: passed formatting, lint, type checks, secret/transfer checks,
  966 unit tests, 153 HTTP contract tests and compilation.
- `node --test test/admin-notifications.integration.mjs test/realtime.integration.mjs`:
  passed, 9 tests including parent/subtests. Uses owned loopback MongoDB/Redis and
  fake FCM. Covers multi-page fan-out, concurrent replicas, expired leases, binding
  changes, retries, invalid tokens, empty audiences, exhaustion, account deletion,
  operation idempotency, audit and revoked admin access. The existing realtime
  suite covers committed changes across independent feeds and authorization fences.
- `pnpm exec vitest run src/users/account-deletion-cleanup.service.spec.ts`: 10 passed.
- `pnpm run build`: passed again after final contract alignment.

From `dashboard/`:

- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`,
  `npm run build`: passed; 86 tests. Vite reports its existing >500 kB main-chunk
  warning; the notification page is separately loaded.
- `npm run test:e2e -- notifications.spec.ts`: passed in installed desktop Chrome
  with the standard isolated backend startup/login fixture. Broadcast requests and
  socket snapshots in this browser test are mocked. It verifies reviewed sending,
  live history without HTTP polling, and a narrow viewport without overflow.
- Desktop and narrow-view screenshots were inspected under ignored `test-results/`.

`git diff --check` passed. OpenAPI YAML and the new local schema/response references
were parsed and resolved using the existing `js-yaml` dependency. Initial failures
found during implementation (query sanitization, controller inventory and global
Nest guard ordering) were corrected and their affected checks passed afterward.

## Boundaries

This history covers dashboard broadcasts, not existing job-result notification
history. FCM acceptance is not proof of device delivery or reading. Only eligible
native registrations are reachable; browser-only accounts are not. Current Android
clients let FCM display notifications in the background but do not display foreground
announcement banners. iOS requires working APNs provisioning and permission.

Provider submission is at least once: timeout/crash after acceptance and before
receipt persistence can duplicate a submission. Stable event/collapse identifiers
reduce duplicate presentation but do not promise exactly-once delivery. Broadcasts
cannot be recalled. No live Firebase/APNs or simulator/device delivery test ran.

API preflight used the official [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-09-29: OpenAPI (101), endpoint security (104), compatibility (106),
snake_case (118), pagination (159) and problem responses (176). Repository receipt,
role and lowercase-state conventions remain authoritative.
