# Audio processing operations

New audio processing is temporarily unavailable while the execution architecture
is redesigned. The API does not currently claim, dispatch, execute, or reconcile
new separation work.

## Current operator responsibilities

- Keep MongoDB, Redis, Firebase, and the private S3 integration configured for the
  surviving account, history, completed-result, deletion, and notification flows.
- Keep existing media private and preserve the configured S3 versioning, public
  access block, encryption, and lifecycle controls.
- Treat `PROCESSING_UNAVAILABLE` as the intentional response for creation, retry,
  upload-renewal, and upload-confirmation requests.
- Continue monitoring storage cleanup, notification delivery, account deletion,
  and authenticated result-download failures.
- Do not add a database migration or automatic collection deletion for this
  cleanup. Obsolete local data is removed manually by the operator.

## Surviving behavior

Owner-scoped job history, rename, cancellation, deletion, and completed-result
download grants remain available. Storage cleanup remains durable and scoped to
the exact retained job keys. Account deletion continues to fence access, hide the
account during recovery, and schedule owned media cleanup.

The API identity still needs only the permissions required by those surviving
storage operations. Signed URLs are short-lived capabilities and must never be
logged or included in support records.

## Validation boundary

`npm run verify` and the isolated integration suites exercise local code with
test-owned services and provider doubles. They do not modify a developer or
production database and do not establish live Firebase, S3, notification, or
deployment readiness.
