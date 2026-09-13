# Media policy v2 and shared allowance

`GET /processing-policy?schemaVersion=2` returns versioned inclusive media limits,
preparation profile, queue/allowance policy and evidence availability. Omitted/1
preserves legacy exclusive limits. The public revision advances for edits to either
processing settings document. `GET /processing-usage` requires account auth and
uses `Cache-Control: no-store`; legacy-safe intake availability is independent of
expanded hardware qualification. Admission remains authoritative.

V2 job metadata supplies `policyVersion: 2`,
`preparationProfileId: preserve-or-aac-lc-256-v1`, and `source` of `audio_file`,
`video_file`, or `youtube`. Accepted qualification/limits are immutable snapshots.
Physical maxima are inclusive 1800 seconds and 100000000 prepared audio bytes;
long-job pause means duration greater than 600 seconds. All origins share one
unfinished job and 3600 audio seconds per rolling 86400 seconds by default.

Mongo transactions reserve account usage and global capacity before issuing a
storage grant. The existing global and account admission fences serialize races.
Unfinished Job documents are the durable global reservations; usage ledger job IDs
are unique. Upload renewal cannot extend the accepted upload deadline. History
removal does not refund usage. Terminal success debits rounded measured duration;
pre-AI cancellation and service failure release. Cancellation after completed
separation debits full duration. Confirmed stopped partial separation uses measured
separator seconds divided by the accepted cost ratio, bounded to measured audio.
Unknown terminal timing reserves conservatively until terminal observation plus
86400 seconds; unfinished reservations never expire automatically. Late trusted
reconcile evidence settles pending usage immediately and idempotently.

The scheduler uses account eligibility, one running attempt per account, actual
recent separator time and aging. Unknown legacy timing stays unknown. It does not
invent wall-clock execution or wait estimates. Short/long dashboard distribution
uses the fixed 600-second boundary for display, not a discrete scheduler tier.

## Worker compatibility

Identity advertises `mediaPolicyVersion: 2`; upgraded claims opt in with the same
field. Registry-enabled identity and fresh capability are required for qualified
expanded admission. Valid heartbeat refreshes known capability; legacy claims
clear it. Old workers never receive expanded jobs. New opt-in assignments carry
`processingLimits`: policyVersion, maxDurationSeconds, durationInclusive,
maxInputBytes, inputBytesInclusive, maxOutputBytes, outputBytesInclusive,
probeTimeoutSeconds, processingTimeoutSeconds, costModelRevision. Legacy jobs
retain exclusive 600s/30MB and the existing 7200-second processing timeout.

Optional stage/output/terminal/reconcile `executionEvidence` contains eventId,
separatorExecutionSeconds, processingStartedAt, measuredAudioSeconds,
stoppedConfirmed, and optional separationCompleted. Reconcile evidence references
the previous owned attempt. Event identity/hash, monotonic timing, observed server
bounds, stop proof and measured duration are validated before ledger changes.
Repeated previous-attempt evidence remains valid after replacement/terminal state.

## Admin activation and exceptions

GET/PUT `/admin/settings/processing-v2` uses settings permissions; writes require
fresh authentication, operationId, expectedRevision, reason and schemaVersion 2.
Qualification may be null. Activation requires a complete, unexpired measured
qualification and a currently compatible worker. Qualification includes source and
preparation bounds, worker/output/probe/processing budgets, evidence/compatibility
revision, qualified worker IDs, a measured linear cost model and global estimated
worker-seconds cap. Probe budget is at most 600 seconds; cost revision at most 128
characters. Qualification expires within 30 days. Existing expired evidence can
be explicitly preserved for unrelated policy edits; it cannot activate expansion.
Defaults leave expanded jobs disabled and qualification absent. Do not populate
synthetic benchmark values in production.

GET `/admin/users/:id/processing-usage` returns private usage and override state.
PUT `/admin/users/:id/processing-allowance` accepts allowanceAudioSeconds
(3600..86400), expiresAt (future, at most 30 days), and the standard mutation fields.
POST `clear-processing-allowance` clears it. Existing suspend-processing accepts
optional expiresAt. Expiry is enforced at read/admission/claim time. Writes are
revision-protected and audited in the same transaction. Audit `processingChanges`
is an allowlisted array of `{field,before,after}` for policy/account values and
expiry; receipts never store media metadata or secrets.

New collections `processing_queue_policy`, `processing_usage_ledger`, and
`processing_execution_usage` are additive. Settled usage/execution retention uses
TTL indexes; unfinished reservations have no TTL. Existing jobs remain accepted
under their original snapshots. No backfill or live worker mutation is required.

## Stable worker management revision

Worker admin `revision` / `expectedRevision` refer to `managementRevision` on the
control record. Only successful admin changes advance it; idle claim polling and
heartbeats retain it. Missing legacy fields read as zero and initialize on the
first admin change. Existing pages loaded before this deployment may need one
refresh. The internal `controlRevision` still advances for worker authority and
credential serialization. Stopped-worker recovery additionally checks the current
internal revision and exact job/attempt/session/generation and stop evidence.
