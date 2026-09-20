# Backend security planning changelog

## 2026-09-20 — Branch 4 checkpoints D1–D6 complete

- Added atomic hourly abuse buckets with 90-day TTL, compact monthly summaries,
  bounded projections/pagination, true first/last times, and current restriction
  state without raw identifiers, payloads, URLs, or stack traces.
- Added layered account, IP, endpoint, and service Redis budgets for processing,
  deletion/recovery, and administrator operations while preserving MongoDB as the
  durable quota authority and fail-closed outage behavior.
- Replaced the embedded processing-suspension fields/routes/UI with one revisioned,
  audited account restriction record; applying a restriction cancels unfinished
  work and fences worker ownership while authentication/deletion/recovery remain.
- Added separate abuse-read and restriction-manage permissions, dashboard filters
  and controls, sanitized Redis/Atlas capacity signals, and an unchanged external
  provider checklist whose items remain unchecked.
- Passed backend verify (769 unit and 140 HTTP E2E tests), 59 isolated integration
  tests across auth/processing/dashboard/deletion, and the dashboard 51-test/build
  gate. One pre-existing APK installer timeout passed alone and on full rerun.
- Recorded implementation commit `33f5a640ba126b3e4f863e1a0aa946995c9dde99`;
  no provider, deployment, live data, device, or browser UI E2E action was run.
- Opened Branch 4 PR #13 against `codex/backend-security-cost-hardening`.

## 2026-09-20 — Branch 4 started at checkpoint D1

- Confirmed Branch 3 PR #12 merged into the collection branch at
  `5151426a87d2712e9064bd222de498cf6b054f5f`.
- Created `hatem/account-abuse-api-limits` from that exact merged collection tip in
  a separate managed worktree.
- Inventoried typed-event, Redis budget, account-state, administrator audit,
  dashboard, health, and provider-boundary requirements.
- Passed 27 focused unit tests, 11 Redis/Mongo/admin integrations, and 18 HTTP
  security/admin E2E tests as the pre-change baseline.
- Kept automatic bans, device enforcement, VPS changes, deployments, and real data
  outside this branch.

## 2026-09-20 — Branch 3 checkpoint C7 complete

- Passed backend format, lint, typecheck, secret scan, 757 unit tests, 137 HTTP
  E2E tests, build, all 13 processing integrations, and 23 dashboard integrations.
- Passed the dashboard format/lint/typecheck/50-test/build gate and Android Direct/
  Play debug assemble, lint, and JVM-test gate without launching a device.
- Passed iOS Swift format and generic simulator compile-for-testing without starting
  a simulator, as requested; runtime UI E2E remains deferred.
- Audited obsolete retry/active-job symbols, JSON, relative Markdown links, and
  whitespace; confirmed MongoDB jobs remain the sole queue authority.
- Recorded implementation commit `ffdadf8f3950d2afc8d0a52ac98499c5c86e0599`
  and marked Branch 3 ready for collection review.

## 2026-09-20 — Branch 3 checkpoint C6 complete

- Added direct race coverage for cancellation winning claim, account restriction or
  deletion blocking claim, lease renewal winning recovery, cancel/finalize single
  settlement, and a stale attempt losing to a newer owner.
- Preserved exact machine, worker, session, slot, incarnation, revision, and attempt
  ownership filters and kept internal admission/worker fields out of public jobs.
- Proved stale attempt output keeps its exact orphan-cleanup task and cannot publish.
- Confirmed MongoDB jobs remain the only queue authority with no BullMQ, Redis queue,
  duplicate queue collection, or additional eligibility index; advanced to C7.

## 2026-09-20 — Branch 3 checkpoint C5 complete

- Moved retry authority from mutable fleet settings into each immutable admission
  snapshot: three total infrastructure attempts and five client/input attempts.
- Persisted worker attempt failure class and bounded `nextAttemptAt` together with
  attempt number, and retained attempt-scoped output keys and stale-result fences.
- Made attempt three terminal with one full usage release, while retryable attempts
  preserve the same job and processing reservation.
- Counted only newly issued logical-audio upload grants; identical request replay
  returns the existing receipt without consuming another attempt.
- Verified existing Android/iOS durable retry identities stop on new-input-required
  and do not create hidden retry loops; advanced to C6.

## 2026-09-20 — Branch 3 checkpoint C4 complete

- Audited every terminal job write and confirmed success, failure, upload expiry,
  owner/admin/deletion cancellation, and worker failure share one idempotent usage
  settlement path.
- Fixed lease-exhaustion recovery so terminal infrastructure failure or cancellation
  releases the reservation in the same MongoDB transaction; retryable lease loss
  preserves it without an extra charge.
- Added a concurrent cancel-versus-finalize integration race proving one job winner
  and exactly one reservation/counter settlement.
- Passed typecheck, recovery unit tests, build, and all 13 processing integrations;
  advanced Branch 3 to C5.

## 2026-09-20 — Branch 3 checkpoint C3 complete

- Extended FIFO worker selection to keep scanning `(queuedAt, _id)` when an older
  account is ineligible, preventing queue head-of-line blocking.
- Rechecked account state/suspension, effective policy, reserved usage, retry time,
  recipe support, processing capacity, machine, session, and slot fences inside the
  claim transaction.
- Reused the existing account fence and worker-claim index; no queue collection or
  MongoDB index was added.
- Passed typecheck, four focused files / 26 tests, and all 13 processing
  integrations including concurrent same-account claim protection; advanced C4.

## 2026-09-20 — Branch 3 checkpoint C2 complete

- Replaced the legacy combined active-job limit with separate immutable waiting
  and processing limits: three `awaiting_upload`/`queued` jobs and one processing
  job per account.
- Reused the account transaction fence for create and worker-claim admission,
  added safe full-capacity guidance, and preserved create/confirm idempotency.
- Updated backend, dashboard, Android, and iOS usage contracts so one processing
  job still permits preparation until the three waiting slots are full.
- Passed backend typecheck, five focused files / 36 tests, all 13 processing
  integrations, dashboard typecheck/tests, and focused Android unit tests without
  launching a device; advanced Branch 3 to C3.

## 2026-09-20 — Branch 3 checkpoint C1 complete

- Added one exhaustive status-to-capacity contract for preparing, queued,
  processing, and terminal jobs.
- Added one failure resolver covering every safe job code plus lease expiry, user
  action, account deletion, quota/restriction/deletion state, and queue capacity.
- Centralized safe public messages, infrastructure retry exhaustion, temporary
  object action, and reservation settlement decisions.
- Replaced worker-attempt and lease-recovery local retry logic with the shared
  resolver and made processing usage use the shared status settlement contract.
- Passed format, lint, typecheck, 8 focused files / 63 tests, build, and two isolated
  processing integrations; advanced Branch 3 to C2.

## 2026-09-20 — Branch 3 started at checkpoint C1

- Confirmed Branch 2 PR #11 is merged and fast-forwarded the collection branch to
  merge commit `b774ad18c79866170ea3141320a31f0d4a50de20`.
- Created the isolated `hatem/job-queue-retries-refunds` worktree from that exact
  collection commit and left the unrelated worker-runtime checkout untouched.
- Read the job lifecycle/test contracts and inventoried admission, create/confirm,
  retry/cancel, claim, recovery, attempt finalization, client, and usage paths.
- Passed the six-file/25-test focused unit baseline and the two processing
  usage/job-action integration baselines.
- Marked C1 in progress; no device, provider, deployment, or real-data action ran.

## 2026-09-20 — Branch 2 checkpoint B7 complete

- Passed backend format, lint, typecheck, secret, unit, HTTP E2E, build, processing,
  and dashboard integration gates.
- Passed the dashboard format, lint, typecheck, unit, and production-build gate and
  both Android Direct/Play unit, lint, and debug-build variants.
- Passed iOS format lint and generic compile-for-testing without launching a device
  or simulator, as requested; runtime simulator execution remains deferred.
- Removed the last obsolete media-limit copy and worker output-duration boundary,
  then documented the remaining non-policy numeric matches.
- Validated JSON, relative links, and whitespace; left all 52 provider actions and
  real S3 checks unexecuted for the operator handoff.
- Marked Branch 2 ready for maintainer review and left Branch 3 unauthorized.

## 2026-09-20 — Branch 2 checkpoint B6 complete

- Expanded global and per-account policy controls to cover the selected media,
  upload, download, retained-storage, and signed-URL limits.
- Exposed processing, upload, download, retained-storage, effective-limit, period,
  and reset information in the dashboard from the backend-owned contract.
- Updated Android and iOS parsing, localized errors, boundary behavior, cached
  playback, and stable result-grant request identity for uncertain retries.
- Removed active legacy client decision paths for the former 30 MB/10-minute and
  100 MB/30-minute policies and documented the unified 50 MB/20-minute contract.
- Verified focused backend, dashboard, Android, and compile-only iOS checks without
  launching a device or simulator; advanced Branch 2 to checkpoint B7.

## 2026-09-20 — Branch 2 checkpoint B5 complete

- Added atomic monthly result-grant and estimated-byte accounting against immutable
  object versions, with concurrent and sequential request replay charged once.
- Added one UTC-month service outbound estimate for user result/input and worker
  input grants, with an atomic safety ceiling before new signed URLs are issued.
- Preserved Android and iOS private-cache playback paths so valid local results do
  not request or consume another backend grant.
- Covered byte and grant boundaries, concurrent races, expiry, object changes,
  missing objects, wrong ownership, restricted/deleting accounts, and service scope.
- Verified TypeScript, focused unit tests, the full backend unit suite, and the
  replica-set processing-usage integration; advanced Branch 2 to checkpoint B6.

## 2026-09-20 — Branch 2 checkpoint B4 complete

- Counted each verified published result in one lifetime retained-byte counter and
  blocked only later admission at the account ceiling, preserving in-flight success.
- Released retained bytes transactionally only after exact cleanup completed or the
  object was safely reconciled as missing.
- Scheduled terminal input cleanup while leaving retry-eligible failed inputs intact.
- Signed worker result uploads with required `INTELLIGENT_TIERING` storage-class
  headers while successful outputs remain until job/account deletion.
- Verified focused admission/deletion/cleanup/worker tests and replica-set retained
  accounting, bounded overshoot, and release behavior.
- Advanced Branch 2 to checkpoint B5.

## 2026-09-19 — Branch 2 checkpoint B3 complete

- Hard-capped processing and release upload/download grants at 600 seconds while
  keeping required size, checksum, content-type, and immutability headers signed.
- Added leased exact-version cleanup with confirmed-missing reconciliation; unknown
  abandoned versions still use bounded exact-key discovery without prefix deletion.
- Scheduled invalid confirmation objects and cancelled uploads for durable cleanup,
  while cancelling a pending invalid-object task after a valid confirmation wins.
- Added cancelled-unconfirmed and cancelled-pinned regression coverage plus transient
  and bounded permanent provider-failure tests.
- Verified TypeScript and 12 focused backend files / 73 tests.
- Advanced Branch 2 to checkpoint B4.

## 2026-09-19 — Branch 2 checkpoint B2 complete

- Added atomic per-account upload-grant ceilings for UTC day/month periods and
  idempotent receipt replay without storing presigned URLs.
- Added monthly confirmed-upload byte accounting after exact storage verification,
  with duplicate confirmation charged only once.
- Added a server-owned logical-audio family and shared five-attempt ceiling that a
  changed request UUID or sibling retry job cannot reset.
- Persisted renewal request identity on Android and iOS and rotated it only when a
  genuinely new upload attempt is required.
- Verified backend race/rollover integration, focused backend and Android suites,
  and an iOS generic simulator test build without launching device/UI E2E.
- Advanced Branch 2 to checkpoint B3.

## 2026-09-19 — Branch 2 checkpoint B1 complete

- Removed live legacy 30 MB/10-minute and expanded 100 MB/30-minute admission
  paths in favor of one inclusive 50,000,000-byte/1,200-second policy.
- Made schema version 2 and the preparation profile mandatory for new jobs.
- Added the same bounded offline policy and boundary coverage to Android and iOS.
- Verified backend tests/typecheck, Android JVM tests, and an iOS generic
  simulator test build without launching device/UI E2E.
- Advanced Branch 2 to checkpoint B2.

## 2026-09-19 — Branch 2 started

- Confirmed PR #10 merged into the collection branch at
  `e9691b2a80f7faed64b66f0800827ea545cfe728`.
- Created `hatem/media-s3-cost-protection` from that exact merged collection tip in
  an isolated worktree.
- Marked checkpoint B1 in progress before changing application behavior.
- Limited this branch to unified media limits, transfer accounting, exact-object
  cleanup, retained output, download grants, and S3 cost protection.
- Kept AWS, Atlas, Redis/VPS, Firebase, deployment, and real data changes outside
  this branch; the provider runbook remains a human checklist.

## 2026-09-19 — Branch 1 ready for review

- Replaced the 3,600-second rolling/temporary allowance paths with one account-only
  7,200-second UTC monthly policy.
- Added atomic processing reservations, success consumption, complete failure/cancel
  release, bounded retention, and concurrency coverage.
- Added revisioned global policy and one optional audited account override with
  administrator dashboard controls.
- Updated backend, dashboard, Android, and iOS contracts to explain the same
  effective account usage; device identity remains history only.
- Removed legacy settings/allowance routes and controls while keeping public policy
  schema version 1 compatibility.
- Passed backend, isolated integration, dashboard, Android, iOS focused/static, and
  documentation gates. Further device/UI E2E was deferred by maintainer request.
- Stopped before Branch 2, which remains unauthorized until review and merge.

## 2026-09-19 — Branch 1 started

- Recorded maintainer approval of the execution package.
- Created `hatem/account-quotas-admin-controls` from collection commit
  `0f8fb0572a309029dc6ada24d9da1c0fbfb8e0eb` in an isolated worktree.
- Marked checkpoint A1 in progress before changing application behavior.
- Limited this branch to account policy, monthly processing usage, account
  overrides, administrator controls, and their client contracts.

## 2026-09-19 — Documentation package created

- Replaced the earlier eight-area proposal with five sequential implementation
  branches accepted by the maintainer.
- Fixed account-only UTC calendar-month limits and deferred device enforcement.
- Fixed one-processing/three-waiting queue behavior, oldest-eligible picking, three
  total infrastructure attempts, full failure refund, and five input attempts.
- Fixed S3 upload/download/storage limits, ten-minute grants, Intelligent-Tiering,
  successful-output retention, and provider/manual boundaries.
- Fixed typed abuse events plus manual restrictions, with automatic bans deferred.
- Fixed fifteen-day deletion recovery and permanent account/media cleanup.
- Added checkpoint/task tracking, machine-readable branch state, evidence/PR
  templates, repository replacement map, architecture contracts, test strategy,
  provider runbook, and official sources.
- Marked every implementation checkpoint `NOT_STARTED`. No application code,
  provider setting, deployment, or real data was changed.
