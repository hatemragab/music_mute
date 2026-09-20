# Branch 5: account deletion and permanent cleanup

**Branch:** `hatem/account-deletion-cleanup`
**Create from:** updated collection after branch 4 merge
**PR base:** `codex/backend-security-cost-hardening`
**Checkpoints:** E1–E6
**Status:** `READY_FOR_REVIEW`
**Current checkpoint:** E6 complete
**Evidence:** `../evidence/05-account-deletion-cleanup.md`

## Assignment

Use one exact fifteen-day grace period, integrate all data added by branches 1–4,
and permanently purge account data/audio through the existing fenced, retryable
cleanup foundation.

## Prerequisites

- [x] Confirm branch 4 is accepted/merged and fetch the new collection tip.
- [x] Record exact ancestry and starting SHA.
- [x] Read architecture 05/06 and the current account-deletion operations guide.
- [x] Search every Mongo schema, Redis key family, S3 identity, notification store,
      installation link, Firebase action, client store, and dashboard/public page for
      account ownership.
- [x] Record a purge inventory including all schemas added by branches A–D.
- [x] Run existing deletion/recovery/cleanup tests as baseline.

## E1. Fifteen-day contract

- [x] Replace calendar-month recovery computation with `acceptedAt + 15 * 24h`.
- [x] Preserve recent-authentication and identity ownership fences.
- [x] Make duplicate deletion requests return the same operation/deadline.
- [x] Publish the exact backend deadline in API responses.
- [x] Replace every stale public and client recovery-period string.
- [x] Test before, exact, and after-deadline boundaries and clock-independent logic.

**Exit:** one fifteen-day rule controls backend, clients, dashboard, and docs.

## E2. Grace-period and recovery behavior

- [x] Block jobs, upload/download grants, retries, and new worker ownership while
      deleting.
- [x] Allow deletion status and verified recovery.
- [x] Fence or safely cancel existing in-flight work without stale finalization.
- [x] Restore the same account ID/jobs/data before the deadline.
- [x] Preserve monthly usage, reservations, override expiry, events, and restriction.
- [x] Prevent recovery from awarding quota, duplicating jobs, or reviving old attempts.
- [x] Test duplicate/concurrent delete/recover and recover-vs-purge races.

**Exit:** grace is recoverable but cannot create cost or reset account history.

## E3. Permanent purge coverage

- [x] Fence/cancel work and reconcile every owned job.
- [x] Delete/reconcile exact input, published output, and stale-attempt S3 versions.
- [x] Remove jobs/errors, usage/reservations/adjustments, override, events,
      restriction, notifications, pushes, and recovery records.
- [x] Remove installation ownership/session links and personal profile fields.
- [x] Delete the Firebase identity through the existing safe provider boundary.
- [x] Prove no account-owned schema from branches 1–4 is omitted.
- [x] Avoid broad prefix/database/Redis destructive operations.

**Exit:** purge inventory and tests account for every durable personal-data owner.

## E4. Resumability, idempotency, and tombstone

- [x] Keep bounded leased phases/cursors and account-state/token fences.
- [x] Resume safely after failure following every irreversible phase.
- [x] Treat already-missing resources as reconciled success.
- [x] Keep transient provider failure retryable without exposing provider details.
- [x] Prevent recovery after irreversible purging begins.
- [x] Define and test the minimal non-personal completion tombstone.
- [x] Verify tombstone/logs contain none of the prohibited personal fields.

**Exit:** any cleanup interruption can resume without double deletion or personal
data remaining silently.

## E5. Client, dashboard, public, and operations updates

- [x] Update Android deletion journal/lifecycle and tests.
- [x] Update iOS deletion store/UI and tests.
- [x] Update dashboard recovery/request phase and safe failure presentation.
- [x] Update public `/delete-account`, privacy copy, root/backend/mobile docs, and
      operator guide to fifteen days.
- [x] Keep provider/manual steps explicitly separate and unchecked.
- [x] Add accessible localized deadline/recovery/permanence copy.

**Exit:** every user/operator surface describes the same lifecycle and limitations.

## E6. Verification and final handoff

- [x] Run deletion/recovery policy/service/cleanup/maintenance unit tests.
- [x] Run deletion integration tests with isolated MongoDB/Redis/provider doubles.
- [x] Run failure injection after every cleanup phase and verify resume.
- [x] Run backend format/verify plus auth/processing/deletion/dashboard integrations.
- [x] Run the dashboard gate.
- [x] Run Android build/lint/unit tests.
- [x] Run iOS formatting/tests only on the authorized simulator.
- [x] Run privacy/sensitive-data, docs/JSON/link, and whitespace checks.
- [x] Update task, roadmap, manifest, evidence, changelog, and final PR comparison.
- [x] Record real Firebase/S3/deployed deletion as `NOT_RUN` unless separately
      authorized and actually exercised with test-owned data.

**Exit:** reviewed PR is ready against the collection branch. Stop. Do not merge
the collection to `main`, deploy, or perform a real account deletion without a new
explicit instruction.
