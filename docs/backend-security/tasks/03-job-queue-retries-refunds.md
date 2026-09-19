# Branch 3: job queue, retries, and refunds

**Branch:** `hatem/job-queue-retries-refunds`
**Create from:** updated collection after branch 2 merge
**PR base:** `codex/backend-security-cost-hardening`
**Checkpoints:** C1–C7
**Status:** `NOT_STARTED`
**Current checkpoint:** C1
**Evidence:** `../evidence/03-job-queue-retries-refunds.md`

## Assignment

Permit one processing job and three waiting jobs per account, choose the oldest
eligible work, and make retry/refund behavior explicit and idempotent. Preserve the
durable MongoDB queue and existing worker claim/lease/attempt fencing.

## Prerequisites

- [ ] Confirm branch 2 is accepted/merged and fetch the new collection tip.
- [ ] Record ancestry and exact starting SHA.
- [ ] Read architecture 03/06 and worker control-plane contracts.
- [ ] Inventory admission statuses, create/confirm/retry/cancel flows, claim query,
      recovery scanner, attempt finalization, clients, and usage settlement.
- [ ] Run focused admission/job/claim/recovery/usage tests as baseline.

## C1. Failure and state contract

- [ ] Define preparing, queued, processing, and terminal capacity groups.
- [ ] Define infrastructure transient/terminal, client/input, user-action, and
      policy failure classes.
- [ ] Map every existing safe error/recovery path to exactly one class.
- [ ] Decide and document the charge point and reservation settlement for each
      transition.
- [ ] Remove or replace ambiguous legacy retry behavior and conflicting limits.
- [ ] Update state/error contract tests before implementing selection changes.

**Exit:** every failure has one retry, refund, cleanup, and public-error outcome.

## C2. Bounded account admission

- [ ] Atomically enforce one processing and three waiting jobs per account.
- [ ] Count both awaiting-upload and queued work as waiting.
- [ ] Allow later accepted jobs to upload and wait while one job processes.
- [ ] Reject the fourth waiting job with safe capacity/reset/action information.
- [ ] Ensure two concurrent creates/confirms cannot over-admit.
- [ ] Preserve request idempotency and immutable job/policy snapshots.
- [ ] Test active, restricted, deleting, quota-exhausted, and storage-full accounts.

**Exit:** an account can own at most four nonterminal jobs in the accepted grouping.

## C3. Oldest eligible picker

- [ ] Extend the existing atomic claim query with account-processing eligibility.
- [ ] Order by `queuedAt`, then `_id`.
- [ ] Recheck account, reservation, retry time, recipe, worker, session, and slot
      fences inside the claim transaction.
- [ ] Prevent two workers from claiming two jobs for the same account.
- [ ] Ensure an ineligible oldest job does not block later eligible accounts.
- [ ] Preserve replay of a lost successful claim response.
- [ ] Add only necessary indexes and explain their Atlas storage/query cost.

**Exit:** the backend offers the oldest eligible job while MongoDB remains the only
queue authority.

## C4. Usage settlement and refunds

- [ ] Reserve confirmed duration before queue eligibility.
- [ ] Consume the reservation once on exact successful finalization.
- [ ] Reuse it through infrastructure attempts without extra cost.
- [ ] Release it fully on eligible cancellation or terminal infrastructure failure.
- [ ] Keep client/input failures free of processing charges.
- [ ] Reconcile crash points between job, attempt, result, and usage changes.
- [ ] Test duplicate/late settle and cancel-vs-finalize races.

**Exit:** every terminal job has one explainable settlement and no double charge.

## C5. Retry limits

- [ ] Enforce three total infrastructure attempts: initial plus two requeues.
- [ ] Store attempt number, failure class, and bounded `nextAttemptAt` durably.
- [ ] Give every processing retry a new attempt/output key and preserve old-attempt
      fencing/cleanup.
- [ ] Fail and fully release after attempt three.
- [ ] Enforce five newly issued client/input attempts per logical-audio family.
- [ ] Keep HTTP/idempotent replay outside the attempt count.
- [ ] Update Android/iOS retry UI and durable local intents without hidden loops.

**Exit:** retry behavior is bounded, visible, and cannot multiply reservations.

## C6. Race, cancellation, and compatibility hardening

- [ ] Test lease renewal vs recovery, cancel vs claim, cancel vs finalize, account
      restriction/deletion vs claim, and stale result vs new attempt.
- [ ] Preserve exact claim/session/slot/incarnation ownership checks.
- [ ] Keep public job history, playback, rename, cancel, retry, and delete contracts
      compatible or update clients atomically.
- [ ] Keep internal account/worker ownership fields out of public serializers.
- [ ] Schedule exact temporary/stale object cleanup for every losing path.
- [ ] Verify no new BullMQ/Redis queue or duplicate queue collection exists.

**Exit:** concurrent and late operations cannot create a second owner or publish a
stale result.

## C7. Verification and handoff

- [ ] Run focused admission, job action, usage, claim, attempt, recovery, cleanup,
      and presenter tests.
- [ ] Run isolated processing persistence/usage/action integration tests.
- [ ] Run backend format/verify and relevant dashboard integration tests.
- [ ] Run dashboard gate if queue/admin UI changed.
- [ ] Run Android/iOS client gates if job-state/retry contracts changed.
- [ ] Run documentation/JSON/link/whitespace checks.
- [ ] Search for obsolete active-job/retry constants and explain remaining matches.
- [ ] Update task, roadmap, manifest, evidence, and changelog.

**Exit:** reviewed PR is ready against the collection branch. Stop before branch 4.
