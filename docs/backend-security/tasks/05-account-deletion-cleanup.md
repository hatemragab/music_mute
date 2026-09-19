# Branch 5: account deletion and permanent cleanup

**Branch:** `hatem/account-deletion-cleanup`
**Create from:** updated collection after branch 4 merge
**PR base:** `codex/backend-security-cost-hardening`
**Checkpoints:** E1–E6
**Status:** `NOT_STARTED`
**Current checkpoint:** E1
**Evidence:** `../evidence/05-account-deletion-cleanup.md`

## Assignment

Replace the current three-month recovery delay with an exact fifteen-day grace
period, integrate all data added by branches 1–4, and permanently purge account
data/audio through the existing fenced, retryable cleanup foundation.

## Prerequisites

- [ ] Confirm branch 4 is accepted/merged and fetch the new collection tip.
- [ ] Record exact ancestry and starting SHA.
- [ ] Read architecture 05/06 and the current account-deletion operations guide.
- [ ] Search every Mongo schema, Redis key family, S3 identity, notification store,
      installation link, Firebase action, client store, and dashboard/public page for
      account ownership.
- [ ] Record a purge inventory including all schemas added by branches A–D.
- [ ] Run existing deletion/recovery/cleanup tests as baseline.

## E1. Fifteen-day contract

- [ ] Replace calendar-month recovery computation with `acceptedAt + 15 * 24h`.
- [ ] Preserve recent-authentication and identity ownership fences.
- [ ] Make duplicate deletion requests return the same operation/deadline.
- [ ] Publish the exact backend deadline in API responses.
- [ ] Replace every three-month/seven-day/stale public and client string.
- [ ] Test before, exact, and after-deadline boundaries and clock-independent logic.

**Exit:** one fifteen-day rule controls backend, clients, dashboard, and docs.

## E2. Grace-period and recovery behavior

- [ ] Block jobs, upload/download grants, retries, and new worker ownership while
      deleting.
- [ ] Allow deletion status and verified recovery.
- [ ] Fence or safely cancel existing in-flight work without stale finalization.
- [ ] Restore the same account ID/jobs/data before the deadline.
- [ ] Preserve monthly usage, reservations, override expiry, events, and restriction.
- [ ] Prevent recovery from awarding quota, duplicating jobs, or reviving old attempts.
- [ ] Test duplicate/concurrent delete/recover and recover-vs-purge races.

**Exit:** grace is recoverable but cannot create cost or reset account history.

## E3. Permanent purge coverage

- [ ] Fence/cancel work and reconcile every owned job.
- [ ] Delete/reconcile exact input, published output, and stale-attempt S3 versions.
- [ ] Remove jobs/errors, usage/reservations/adjustments, override, events,
      restriction, notifications, pushes, and recovery records.
- [ ] Remove installation ownership/session links and personal profile fields.
- [ ] Delete the Firebase identity through the existing safe provider boundary.
- [ ] Prove no account-owned schema from branches 1–4 is omitted.
- [ ] Avoid broad prefix/database/Redis destructive operations.

**Exit:** purge inventory and tests account for every durable personal-data owner.

## E4. Resumability, idempotency, and tombstone

- [ ] Keep bounded leased phases/cursors and account-state/token fences.
- [ ] Resume safely after failure following every irreversible phase.
- [ ] Treat already-missing resources as reconciled success.
- [ ] Keep transient provider failure retryable without exposing provider details.
- [ ] Prevent recovery after irreversible purging begins.
- [ ] Define and test the minimal non-personal completion tombstone.
- [ ] Verify tombstone/logs contain none of the prohibited personal fields.

**Exit:** any cleanup interruption can resume without double deletion or personal
data remaining silently.

## E5. Client, dashboard, public, and operations updates

- [ ] Update Android deletion journal/lifecycle and tests.
- [ ] Update iOS deletion store/UI and tests.
- [ ] Update dashboard recovery/request phase and safe failure presentation.
- [ ] Update public `/delete-account`, privacy copy, root/backend/mobile docs, and
      operator guide to fifteen days.
- [ ] Keep provider/manual steps explicitly separate and unchecked.
- [ ] Add accessible localized deadline/recovery/permanence copy.

**Exit:** every user/operator surface describes the same lifecycle and limitations.

## E6. Verification and final handoff

- [ ] Run deletion/recovery policy/service/cleanup/maintenance unit tests.
- [ ] Run deletion integration tests with isolated MongoDB/Redis/provider doubles.
- [ ] Run failure injection after every cleanup phase and verify resume.
- [ ] Run backend format/verify plus auth/processing/deletion/dashboard integrations.
- [ ] Run the dashboard gate.
- [ ] Run Android build/lint/unit tests.
- [ ] Run iOS formatting/tests only on the authorized simulator.
- [ ] Run privacy/sensitive-data, docs/JSON/link, and whitespace checks.
- [ ] Update task, roadmap, manifest, evidence, changelog, and final PR comparison.
- [ ] Record real Firebase/S3/deployed deletion as `NOT_RUN` unless separately
      authorized and actually exercised with test-owned data.

**Exit:** reviewed PR is ready against the collection branch. Stop. Do not merge
the collection to `main`, deploy, or perform a real account deletion without a new
explicit instruction.
