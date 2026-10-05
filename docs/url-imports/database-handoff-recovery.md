# Durable database handoff recovery

## Failure and decision

The October 4 investigation correlated provider, router and API timestamps. One
source completed acquisition, validation and R2 confirmation before two job
submission transactions exhausted their ten-second budgets with MongoDB write
conflicts. The second error marked the import failed although the shared source
was already confirmed. Download retries and a different proxy could not resolve
that database handoff.

The fix preserves MongoDB, the existing private storage identities, transactional
admission and the shared-media outbox. No production rows are rewritten and no
collection or index is dropped. Database availability and capacity still require
operational monitoring; this design makes transient handoff failures recoverable
instead of requiring another paid acquisition or a manual retry.

## Reduce conflicts and transaction work

Account checks for owned import/job snapshots use primary read-only existence
queries before and after the awaited lookup. They do not increment the account's
access revision. Admission, grants, worker commands and deletion retain their
transactional write fences and ownership checks.

Shared job admission resolves policy once in each transaction callback, after
its global/account/access fences. Processing reservation, upload receipts,
confirmed-byte accounting and retained-media accounting reuse that exact policy.
A restarted transaction resolves policy again; no account policy is cached across
transactions or accounts. This reduces a fresh source handoff from four effective
policy reads to one without removing quota or policy checks.

## Recover the confirmed source

The import stores a separate `handoffPending` flag and `handoffAttempt` generation.
These internal fields do not change the public import statuses or acquisition
attempt budget. A transient post-upload submission failure retains the original
import, job request UUID, confirmed source/result keys, input and allowance hold.
It becomes queued with a due time and capped backoff.

Handoff executions only inspect/recover the existing confirmed media and submit
the original idempotent job command. They cannot reserve acquisition, contact the
provider or upload the source again. They still work after the fourth acquisition
attempt and for legacy imports whose acquisition ceiling is one. A confirmed
job whose response was lost is recovered first.

Queue IDs include the handoff generation. Status, generation and execution checks
prevent old or duplicate workers from taking ownership of a later execution.
MongoDB remains the outbox: the existing bounded recovery scan recreates missing
queue entries after process restart or Redis interruption. Retry due times also
apply to direct cached-result delivery. Waiting retries release the worker slot.

The import hold survives database contention and is exchanged atomically when
job creation commits. If the result became ready during recovery, its delivery
also exchanges that hold and accounts an original source transfer once. Existing
account restrictions, permanent media/policy errors and ordinary quota rejection
retain their terminal behavior and cleanup. Historical failed imports are not
automatically replayed.

## Compatibility and validation

New internal schema fields have defaults. Existing requests, HTTP routes, public
errors and WebSocket snapshots remain compatible; queued imports use the existing
server-side runtime rather than client status polling. Acquisition concurrency
and the three Residential plus one Mobile attempt policy remain separate.

Regression checks cover read-only snapshots, policy isolation across transaction
callbacks, repeated confirmed-source submission failures, missing queue entries,
restart repair, stale workers, acquisition attempt four, preserved object identity,
exactly-once allowance/transfer accounting and permanent account/policy rejection.
Local integration uses isolated MongoDB/Redis and synthetic provider/storage
fixtures. It does not establish production provider capacity or database health.

API preflight: the current [Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were reviewed on 2026-10-04 for security, read-only retrieval, compatibility,
secondary-key idempotency and asynchronous commands. No client-visible field or
route is added by this change.

## October 4 local validation

Validation used a frozen backend snapshot because another task was actively
changing unrelated modules in the primary checkout. The release overlays only
11 reviewed runtime modules onto the verified API110 image, preserving all
other runtime files, dependencies and service configuration. It contains no
source files or environment values.

The frozen test tree excluded an absent, unfinished community module and its
fixture additions, plus a new catalog test whose implementation was absent.
Four unrelated files received formatting only in that temporary tree; an
unrelated PCM fixture expectation was rounded to an integer byte count. These
temporary normalizations are excluded from the deployment. A recovery fixture
was corrected in the repository to read the import hold after acquisition had
actually reserved it.

Actual successful checks:

- `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` and
  `pnpm run test:transfer-benchmark` in the frozen component.
- `pnpm test`: 1,547 unit tests; `pnpm run test:e2e`: 183 API fixture tests.
- `pnpm run build` completed in the frozen backend.
- `node --test` across the four URL-import integration files: 38 tests, including
  22 shared-media tests with durable recovery and real transaction contention.
- `node --test` across the processing/accounting integration files: 19 tests.
- `node --test` for realtime, deletion request/cleanup/recovery and infrastructure:
  five integration tests. All integration databases and Redis services were
  isolated fixtures.
- `pnpm run test:secrets` in the real checkout: five scanner tests and the tracked
  secret scan. No developer dotenv was copied into the temporary tree.

Whole-checkout `pnpm run verify` was attempted and encountered concurrent
unrelated module/fixture errors. The passing checks above apply to the frozen
snapshot and the scoped release, not a claim that unfinished work in the whole
checkout passes.

## Production activation

CapRover activated `img-captain-api:111` on 2026-10-04 at
11:44:07.230 UTC (14:44 Cairo). The read-only activation verifier confirmed
readiness HTTP 200, all 22 scoped JS/source-map checksums, unchanged environment
and image configuration, 1,003 unchanged unrelated runtime files, unchanged
dependency manifests and all 30,457 dependency tree files. The router and yt-dlp
services retained their previous images/start times. No production database rows
were migrated or deleted.

A network-disabled candidate runtime probe separately executed a handoff at the
fourth acquisition attempt. It submitted the confirmed result with the original
import hold and made zero downloader, acquisition-reservation or scratch calls.
This was an isolated fixture rather than a forced production outage.

## Main implementation files

- `backend/src/users/account-access.service.ts`,
  `backend/src/jobs/jobs-query.service.ts`: read-only snapshot account checks.
- `backend/src/admin-settings/processing-admission.service.ts`,
  `backend/src/processing-usage/processing-usage.service.ts`,
  `backend/src/jobs/jobs.service.ts`: per-transaction policy reuse and atomic hold
  exchange/accounting for a result that becomes ready during recovery.
- `backend/src/url-imports/media-import.schema.ts`, `import-retry.ts`,
  `imports.service.ts`, `import-processor.ts`, `import-runtime.ts`,
  `import-errors.ts`: durable confirmed-source handoff generations, due times,
  MongoDB outbox repair, permanent-error handling and sanitized failure context.

## Bounded live cache proof

After activation, ten previously confirmed URLs were submitted through the live
single-link web form on the same account. All ten imports reached submitted and
created ten distinct ready jobs in 3,171–3,872 milliseconds per import. Read-only
verification matched every canonical URL, source/result/recipe identity and
confirmed input/output object, with distinct import and job request UUIDs.

The API110-compatible queue path records one execution attempt before inspecting
a ready cache. All ten execution counters were one; none created an acquisition
reservation, import processing reservation or upload-grant receipt. The initial
verification script incorrectly expected zero execution attempts. Its corrected
assertion preserves all identity, reservation and provider-event checks.

The complete observed window, 11:47:50.783–11:59:49.545 UTC on October 4, contained
zero API errors or routine logs and zero provider/router completed-request events.
This is cache delivery evidence; the web form submitted links individually.
Ten simultaneous handoffs and repeated recovery failures were qualified with
isolated transaction fixtures, rather than a production outage or ten new paid
provider acquisitions. The provider log gate covers completed logged requests;
an unfinished request would not be visible through that signal alone.

Historical failed imports are not automatically replayed. They retain their
existing explicit retry action. The new durable recovery applies to active and
future confirmed-source handoffs, including old active rows with missing
handoff-generation fields.
