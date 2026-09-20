# Branch 3: job queue, retries, and refunds

**Branch:** `hatem/job-queue-retries-refunds`
**Create from:** updated collection after branch 2 merge
**PR base:** `codex/backend-security-cost-hardening`
**Checkpoints:** C1–C7
**Status:** `MERGED`
**Current checkpoint:** none
**Evidence:** `../evidence/03-job-queue-retries-refunds.md`

## Assignment

Permit one processing job and three waiting jobs per account, choose the oldest
eligible work, and make retry/refund behavior explicit and idempotent. Preserve the
durable MongoDB queue and existing worker claim/lease/attempt fencing.

## Prerequisites

- [x] Confirm branch 2 is accepted/merged and fetch the new collection tip.
- [x] Record ancestry and exact starting SHA.
- [x] Read architecture 03/06 and worker control-plane contracts.
- [x] Inventory admission statuses, create/confirm/retry/cancel flows, claim query,
      recovery scanner, attempt finalization, clients, and usage settlement.
- [x] Run focused admission/job/claim/recovery/usage tests as baseline.

## C1. Failure and state contract

- [x] Define preparing, queued, processing, and terminal capacity groups.
- [x] Define infrastructure transient/terminal, client/input, user-action, and
      policy failure classes.
- [x] Map every existing safe error/recovery path to exactly one class.
- [x] Decide and document the charge point and reservation settlement for each
      transition.
- [x] Remove or replace ambiguous legacy retry behavior and conflicting limits.
- [x] Update state/error contract tests before implementing selection changes.

**Exit:** every failure has one retry, refund, cleanup, and public-error outcome.

## C2. Bounded account admission

- [x] Atomically enforce one processing and three waiting jobs per account.
- [x] Count both awaiting-upload and queued work as waiting.
- [x] Allow later accepted jobs to upload and wait while one job processes.
- [x] Reject the fourth waiting job with safe capacity/reset/action information.
- [x] Ensure two concurrent creates/confirms cannot over-admit.
- [x] Preserve request idempotency and immutable job/policy snapshots.
- [x] Test active, restricted, deleting, quota-exhausted, and storage-full accounts.

**Exit:** an account can own at most four nonterminal jobs in the accepted grouping.

## C3. Oldest eligible picker

- [x] Extend the existing atomic claim query with account-processing eligibility.
- [x] Order by `queuedAt`, then `_id`.
- [x] Recheck account, reservation, retry time, recipe, worker, session, and slot
      fences inside the claim transaction.
- [x] Prevent two workers from claiming two jobs for the same account.
- [x] Ensure an ineligible oldest job does not block later eligible accounts.
- [x] Preserve replay of a lost successful claim response.
- [x] Add only necessary indexes and explain their Atlas storage/query cost.

**Exit:** the backend offers the oldest eligible job while MongoDB remains the only
queue authority.

## C4. Usage settlement and refunds

- [x] Reserve confirmed duration before queue eligibility.
- [x] Consume the reservation once on exact successful finalization.
- [x] Reuse it through infrastructure attempts without extra cost.
- [x] Release it fully on eligible cancellation or terminal infrastructure failure.
- [x] Keep client/input failures free of processing charges.
- [x] Reconcile crash points between job, attempt, result, and usage changes.
- [x] Test duplicate/late settle and cancel-vs-finalize races.

**Exit:** every terminal job has one explainable settlement and no double charge.

## C5. Retry limits

- [x] Enforce three total infrastructure attempts: initial plus two requeues.
- [x] Store attempt number, failure class, and bounded `nextAttemptAt` durably.
- [x] Give every processing retry a new attempt/output key and preserve old-attempt
      fencing/cleanup.
- [x] Fail and fully release after attempt three.
- [x] Enforce five newly issued client/input attempts per logical-audio family.
- [x] Keep HTTP/idempotent replay outside the attempt count.
- [x] Update Android/iOS retry UI and durable local intents without hidden loops.

**Exit:** retry behavior is bounded, visible, and cannot multiply reservations.

## C6. Race, cancellation, and compatibility hardening

- [x] Test lease renewal vs recovery, cancel vs claim, cancel vs finalize, account
      restriction/deletion vs claim, and stale result vs new attempt.
- [x] Preserve exact claim/session/slot/incarnation ownership checks.
- [x] Keep public job history, playback, rename, cancel, retry, and delete contracts
      compatible or update clients atomically.
- [x] Keep internal account/worker ownership fields out of public serializers.
- [x] Schedule exact temporary/stale object cleanup for every losing path.
- [x] Verify no new BullMQ/Redis queue or duplicate queue collection exists.

**Exit:** concurrent and late operations cannot create a second owner or publish a
stale result.

## C7. Verification and handoff

- [x] Run focused admission, job action, usage, claim, attempt, recovery, cleanup,
      and presenter tests.
- [x] Run isolated processing persistence/usage/action integration tests.
- [x] Run backend format/verify and relevant dashboard integration tests.
- [x] Run dashboard gate if queue/admin UI changed.
- [x] Run Android/iOS client gates if job-state/retry contracts changed.
- [x] Run documentation/JSON/link/whitespace checks.
- [x] Search for obsolete active-job/retry constants and explain remaining matches.
- [x] Update task, roadmap, manifest, evidence, and changelog.

**Exit:** PR #12 is merged into the collection branch. Branch 4 subsequently
completed and merged as PR #13.
