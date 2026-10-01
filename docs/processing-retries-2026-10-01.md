# Processing retries: 2026-10-01

The standard account-policy source default is four total infrastructure
processing attempts: the initial execution and up to three automatic requeues.
The existing engine requeues eligible transient worker failures with stored
`nextAttemptAt` backoff of 5, 10 and 20 seconds. Attempt four failing becomes
terminal, releases the same processing reservation and emits one failure
notification. Non-retryable input/output failures, cancellation and policy
denials retain their existing classification and behavior.

Processing retries reuse the accepted job, verified input, immutable recipe and
processing reservation. [URL-import retries](url-imports/retries-2026-10-01.md)
have a separate, bounded acquisition budget. Each adapter execution still makes
one paid request; explicit client retry commands remain separate from automatic
worker attempts.

An existing `account_policies/standard` document remains authoritative. Changing
the source default does not update that document or frozen job admission
snapshots. To apply this budget to future admissions in an existing deployment,
an authorized operator must use the existing audited account-policy update to
set `max_infrastructure_attempts` to `4`, preserving all other policy values and
using the current revision, a fresh operation UUID and a reason. Existing jobs
retain their admitted budgets; failed jobs are not rewritten or restarted.

The existing authorized `GET /admin/settings/account-policy` provides the saved
revision and `values.max_infrastructure_attempts`. A server-side read of
`AccountPolicyService.current()` provides `revision` and
`values.maxInfrastructureAttempts`; project only those numeric fields when
collecting operational evidence. The operations CLI's `policy` command manages
app-access policy and does not update account-policy values.

Local regression coverage checks the new default admission snapshot, preserves
a saved three-attempt policy, exercises all retryable failure classes through
four attempts, and verifies WorkerAttemptService's three backoffs, terminal
exhaustion and idempotent failure reports. Local fixtures do not establish live
policy application or completed worker retries.

## Live policy application

On 2026-10-01 at 11:23 UTC, the owner-authorized dashboard operation saved the
standard policy as revision 2 with `maxInfrastructureAttempts = 4`. The settings
page read back four total attempts and unchanged other limits after Google
reauthentication and the audited save. This applies to future admissions; frozen
budgets on existing jobs were not rewritten. This establishes live policy
configuration, not a completed four-attempt production worker execution.
