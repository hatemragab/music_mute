# Branch 3 checkpoint report: job queue, retries, and refunds

## Identity

- Assigned branch: `hatem/job-queue-retries-refunds`
- Collection branch: `codex/backend-security-cost-hardening`
- Merged predecessor PR: <https://github.com/hatemragab/music_mute/pull/11>
- Starting collection commit: `b774ad18c79866170ea3141320a31f0d4a50de20`
- Actual tested source: uncommitted Branch 3 worktree changes based on the starting commit
- Pull request URL/base: not opened / `codex/backend-security-cost-hardening`
- Date/time with timezone: 2026-09-20 01:50:07 EEST
- Environment: local macOS isolated worktree; no live provider or real-data access

## Progress

- Branch status: `IN_PROGRESS`
- Current checkpoint: C7
- Completed checkpoints: C1, C2, C3, C4, C5, C6
- Next item: documentation validation and final handoff record
- Blocking input: none

## Scope and replacement inventory

| Area                        | Existing behavior                                        | Action                        | Required result                                                 |
| --------------------------- | -------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| Admission groups            | Every active status shares one account limit             | Replace                       | One processing plus three waiting jobs                          |
| Create/confirm/retry/cancel | Capacity, reservation and retry decisions are split      | Extend                        | Atomic, idempotent transitions under one lifecycle contract     |
| Claim query                 | Global FIFO with worker and attempt fences               | Extend                        | Oldest eligible job without two processing jobs for one account |
| Worker failure handling     | Local retryable-code set and attempts-remaining mutation | Replace                       | One explicit failure class and three-total-attempt policy       |
| Lease recovery              | Separate retry calculation and generic separator error   | Replace                       | Same infrastructure taxonomy and terminal refund outcome        |
| Processing usage            | Durable reserve/use/release primitives already exist     | Reuse and harden              | Exactly one settlement for each terminal outcome                |
| Clients                     | Existing retry/cancel/job-state presentation             | Preserve or update atomically | Safe compatible retry and next-action contract                  |
| MongoDB queue               | Jobs remain the durable queue authority                  | Reuse                         | No BullMQ, Redis queue or duplicate queue collection            |

## Checkpoint results

| ID  | Status        | Evidence                                                                                                                                      | Remaining work                   |
| --- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| C1  | `PASS`        | Exhaustive status/failure/settlement contract is shared by usage, worker failure, and lease recovery; focused tests and integrations pass     | None                             |
| C2  | `PASS`        | Account fence serializes creates and claims; three waiting slots and one processing slot are distinct; concurrent admission and clients pass  | None                             |
| C3  | `PASS`        | FIFO cursor skips ineligible accounts; account/status/policy/reservation/recipe/retry and worker fences are rechecked in one transaction      | None                             |
| C4  | `PASS`        | Terminal transitions and usage settle atomically; lease exhaustion now refunds; duplicate and cancel/finalize races settle exactly once       | None                             |
| C5  | `PASS`        | Immutable admission snapshots bound three infrastructure and five input attempts; durable class/backoff and attempt-scoped output keys tested | None                             |
| C6  | `PASS`        | Exact ownership fences cover renewal/recovery, cancel/claim/finalize, account state, stale outputs, serializers, and cleanup                  | None                             |
| C7  | `IN_PROGRESS` | Backend, integration, dashboard, Android, and compile-only iOS gates pass; documentation validation remains                                   | Documentation and handoff record |

## Commands actually executed

| Directory           | Command                                                                              | Exit | Result                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------ | ---: | ------------------------------------------------------------------------------------------ |
| collection worktree | `git merge --ff-only origin/codex/backend-security-cost-hardening`                   |    0 | Collection advanced to Branch 2 merge commit                                               |
| repository root     | managed worktree creation plus `git switch -c hatem/job-queue-retries-refunds`       |    0 | Branch created from the exact collection tip                                               |
| `backend`           | `pnpm install --frozen-lockfile`                                                     |    0 | Locked backend dependencies installed locally                                              |
| `backend`           | focused admission/job/claim/attempt/recovery Vitest suite                            |    0 | 6 files / 25 tests passed                                                                  |
| `backend`           | build plus processing-usage and job-action integrations                              |    0 | 2 integration tests passed                                                                 |
| `backend`           | C1 typecheck plus focused lifecycle/state/admission/job/claim/attempt/recovery suite |    0 | 8 files / 63 tests passed                                                                  |
| `backend`           | C1 format check, lint, and typecheck                                                 |    0 | Prettier, zero-warning lint, and TypeScript passed                                         |
| `backend`           | C1 build plus processing-usage and job-action integrations                           |    0 | 2 integration tests passed after lifecycle centralization                                  |
| `backend`           | C2 typecheck plus admission/claim/job/storage/lifecycle focused suite                |    0 | 5 files / 36 tests passed                                                                  |
| `backend`           | `pnpm run test:processing:integration` after C2                                      |    0 | 13 isolated processing integration tests passed                                            |
| `dashboard`         | C2 typecheck and focused processing-usage panel test                                 |    0 | TypeScript and 1 file / 3 tests passed                                                     |
| `android`           | focused Direct debug usage repository and API client unit tests                      |    0 | Gradle unit tests passed; no device launched                                               |
| `backend`           | C3 typecheck plus admission/claim/attempt/recovery focused suite                     |    0 | 4 files / 26 tests passed                                                                  |
| `backend`           | `pnpm run test:processing:integration` after C3                                      |    0 | 13 integrations passed, including concurrent account claim                                 |
| `backend`           | lease recovery unit test after terminal settlement fix                               |    0 | 1 file / 3 tests passed                                                                    |
| `backend`           | processing integration after C4 cancel/finalize race                                 |    0 | 13 integrations passed with exactly-once settlement                                        |
| `backend`           | C5 typecheck and retry/lifecycle focused suites                                      |    0 | 3 files / 17 tests passed                                                                  |
| `backend`           | C5 processing integration rerun                                                      |    0 | All 13 processing integrations passed                                                      |
| `backend`           | C6 admission/claim/attempt/lease/recovery/cleanup/presenter suite                    |    0 | 7 files / 47 tests passed                                                                  |
| `backend`           | `pnpm run verify`                                                                    |    0 | Format, lint, typecheck, secret scan, 757 unit tests, 137 HTTP E2E tests, and build passed |
| `backend`           | `pnpm run test:processing:integration`                                               |    0 | All 13 isolated processing integrations passed                                             |
| `backend`           | `pnpm run test:dashboard:integration`                                                |    0 | All 23 dashboard/backend integrations passed                                               |
| `dashboard`         | format, lint, typecheck, 50 unit tests, and production build                         |    0 | Full dashboard gate passed                                                                 |
| `android`           | Direct/Play debug assemble, lint, and JVM unit-test tasks                            |    0 | Gradle gate passed; no device launched                                                     |
| `iOS`               | Swift format lint and generic-simulator `build-for-testing`                          |    0 | App and test targets compiled; no simulator launched                                       |

## Behavioral evidence

- Baseline shows current behavior before C1 replacement; passing tests do not prove
  the new queue/retry/refund contract.
- Existing worker claim/lease/session/slot/incarnation fences are preserved
  foundations, not replacement targets.
- Admission now stores separate immutable waiting/processing limits, counts
  `awaiting_upload` plus `queued` as waiting, and returns safe full-capacity
  guidance without exposing internal queue or worker data.
- The account fence participates in worker claim admission, so concurrent claims
  cannot create two processing jobs for one account.
- The FIFO cursor skips older ineligible accounts and keeps scanning; successful
  claim response replay remains ahead of new selection.
- Claim eligibility now fails closed on account status/suspension, account policy,
  missing or settled reservation, retry time, recipe support, and worker/session/
  slot ownership. The existing claim index is reused, so Atlas gets no new index
  storage or write amplification.
- Lease-exhaustion recovery now settles terminal failed/cancelled reservations in
  the same transaction as job and attempt fencing; retryable lease loss preserves
  the original reservation without charging again.
- Success, failure, upload expiry, and cancellation all use the same idempotent
  reservation transition. Concurrent cancel-versus-finalize testing proves one
  winner and exactly one used-or-released counter mutation.
- Backend, dashboard, Android, and iOS usage contracts now distinguish waiting
  jobs from processing jobs; a processing job no longer blocks preparation.
- Retry authority is frozen in each job's immutable admission snapshot. Worker
  attempt and lease-loss paths persist the attempt number, failure class, and a
  maximum 60-second backoff; attempt three is terminal and releases usage once.
- Every worker attempt receives a new UUID and output key. Exact ownership fences
  reject stale completion while its already-scheduled exact-key cleanup remains.
- Newly issued upload grants increment the server-owned logical-audio root counter;
  replaying the same request UUID returns its receipt without consuming an attempt.
- Existing Android and iOS durable retry intents reuse one request identity after
  uncertain responses and stop on `NEW_INPUT_REQUIRED`; no hidden worker retry loop
  or new public job contract was introduced.
- No BullMQ dependency, Redis queue, queue collection, or additional MongoDB index
  was added.

## Provider boundary

- No provider console, deployment, production database, Redis, S3, Firebase, or
  real user data was read or changed.

## Pending tests and limitations

- Documentation validation and the final immutable commit/PR record remain pending.
- Device/UI E2E remains deferred by maintainer instruction.

## Handoff

- Ready for review: no; C7 documentation handoff in progress
- Next branch: `hatem/account-abuse-api-limits`, unauthorized until Branch 3 merge
